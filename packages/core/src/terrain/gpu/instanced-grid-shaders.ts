/**
 * Shaders of the GPU terrain engine. Every instance draws the same predefined grid, refined on its edges; its
 * instance attributes size and place it:
 *
 * - `instPlace`: tile centre minus camera position, computed in double precision on the CPU, and the shape layer;
 * - `instRotation`: cosine and sine of the centre longitude, longitude span of the tile, and the bits of the edges
 *   whose neighbours are finer, N 1, E 2, S 4, W 8;
 * - `instImagery`: area of the tile in its imagery page, `west, north, size`, and the page layer, `-1` for none;
 * - `instElevation`, `instEdge*`, `instCorner*`: area of the tile in a DEM tile and the layer of its page, `-1` for
 *   none, for the interior, each edge and each corner.
 *
 * Vertices are addressed on the half-cell lattice, `2 * cells` steps per side: grid vertices at even steps, edge
 * midpoints at odd steps along their edge. `position` holds their `u, v`.
 */
export const INSTANCED_GRID_VERTEX = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2DArray;

attribute vec3 position;
attribute vec4 instPlace;
attribute vec4 instRotation;
attribute vec4 instImagery;
attribute vec4 instElevation;
attribute vec4 instEdgeN;
attribute vec4 instEdgeE;
attribute vec4 instEdgeS;
attribute vec4 instEdgeW;
attribute vec4 instCornerNW;
attribute vec4 instCornerNE;
attribute vec4 instCornerSE;
attribute vec4 instCornerSW;

uniform mat4 viewProjection;
uniform float cells;
uniform float verticalScale;
uniform sampler2DArray shapes;
uniform sampler2DArray elevations;

varying vec3 vNormal;
varying vec3 vImagery;

int steps() {
    return int(2.0 * cells + 0.5);
}

// Elevation reference of a lattice point: a corner, an edge, or the interior.
vec4 elevationAt(ivec2 h) {
    int last = steps();
    bool north = h.y == 0;
    bool south = h.y == last;
    bool west = h.x == 0;
    bool east = h.x == last;
    if (north && west) return instCornerNW;
    if (north && east) return instCornerNE;
    if (south && east) return instCornerSE;
    if (south && west) return instCornerSW;
    if (north) return instEdgeN;
    if (east) return instEdgeE;
    if (south) return instEdgeS;
    if (west) return instEdgeW;
    return instElevation;
}

// Height at tile coordinates in a DEM page, interpolated bilinearly between its heights.
float heightIn(vec4 reference, vec2 uv) {
    if (reference.w < 0.0) return 0.0;
    float size = float(textureSize(elevations, 0).x);
    vec2 texel = (reference.xy + uv * reference.z) * (size - 1.0);
    ivec2 base = clamp(ivec2(floor(texel)), ivec2(0), ivec2(int(size) - 2));
    vec2 f = clamp(texel - vec2(base), 0.0, 1.0);
    int layer = int(reference.w + 0.5);
    float h00 = texelFetch(elevations, ivec3(base, layer), 0).r;
    float h10 = texelFetch(elevations, ivec3(base + ivec2(1, 0), layer), 0).r;
    float h01 = texelFetch(elevations, ivec3(base + ivec2(0, 1), layer), 0).r;
    float h11 = texelFetch(elevations, ivec3(base + ivec2(1, 1), layer), 0).r;
    return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y) * verticalScale;
}

// Displaced position of a lattice point, in the frame of the shape, where the tile centre longitude is 0.
vec3 sampledPosition(ivec2 h) {
    vec4 shape = texelFetch(shapes, ivec3(h, int(instPlace.w + 0.5)), 0);
    vec2 uv = vec2(h) / float(steps());
    float longitude = (uv.x - 0.5) * instRotation.z;
    vec3 up = vec3(cos(shape.w) * cos(longitude), cos(shape.w) * sin(longitude), sin(shape.w));
    return shape.xyz + up * heightIn(elevationAt(h), uv);
}

bool finerAcross(int bit) {
    return (int(instRotation.w + 0.5) & bit) != 0;
}

// Position of a lattice point. An edge midpoint lies on the segment between its two neighbours on the edge, the
// segment drawn by a coarser or same-level instance across, unless the instances across are finer: it is then one
// of their vertices and reads its height like them.
vec3 positionAt(ivec2 h) {
    int last = steps();
    h = clamp(h, ivec2(0), ivec2(last));
    bool alongNorthSouth = (h.y == 0 && !finerAcross(1)) || (h.y == last && !finerAcross(4));
    bool alongEastWest = (h.x == last && !finerAcross(2)) || (h.x == 0 && !finerAcross(8));
    if (alongNorthSouth && (h.x & 1) == 1) return 0.5 * (sampledPosition(h - ivec2(1, 0)) + sampledPosition(h + ivec2(1, 0)));
    if (alongEastWest && (h.y & 1) == 1) return 0.5 * (sampledPosition(h - ivec2(0, 1)) + sampledPosition(h + ivec2(0, 1)));
    return sampledPosition(h);
}

// Rotation about the polar axis by the longitude of the tile centre.
vec3 rotate(vec3 p) {
    return vec3(instRotation.x * p.x - instRotation.y * p.y, instRotation.y * p.x + instRotation.x * p.y, p.z);
}

void main(void) {
    ivec2 h = ivec2(floor(position.xy * float(steps()) + 0.5));
    vec3 local = positionAt(h);

    // Normal of the displaced surface, from the neighbours one cell away, clamped to the tile: east cross north.
    vec3 eastward = positionAt(h + ivec2(2, 0)) - positionAt(h - ivec2(2, 0));
    vec3 northward = positionAt(h - ivec2(0, 2)) - positionAt(h + ivec2(0, 2));
    vec3 normal = normalize(cross(eastward, northward));

    vNormal = rotate(normal);
    vImagery = vec3(instImagery.xy + position.xy * instImagery.z, instImagery.w);
    gl_Position = viewProjection * vec4(rotate(local) + instPlace.xyz, 1.0);
}
`;

export const INSTANCED_GRID_FRAGMENT = /* glsl */ `
precision highp float;
precision highp sampler2DArray;

varying vec3 vNormal;
varying vec3 vImagery;

uniform vec3 baseColor;
// Directional light: direction towards the light, colour times intensity.
uniform vec3 sunDirection;
uniform vec3 sunColor;
// Hemispheric light: direction of the sky, sky and ground colours times intensity.
uniform vec3 skyDirection;
uniform vec3 skyColor;
uniform vec3 groundColor;
#ifdef IMAGERY
uniform sampler2DArray imagery;
uniform float imagerySize;
#endif

void main(void) {
    vec3 albedo = baseColor;
#ifdef IMAGERY
    if (vImagery.z >= 0.0) {
        // Point registration: page coordinate t lies at the centre of texel t * (size - 1).
        vec2 uv = (clamp(vImagery.xy, 0.0, 1.0) * (imagerySize - 1.0) + 0.5) / imagerySize;
        albedo = texture(imagery, vec3(uv, floor(vImagery.z + 0.5))).rgb;
    }
#endif
    vec3 normal = normalize(vNormal);
    // The lighting of the Babylon standard material, without specular.
    vec3 light = sunColor * max(dot(normal, sunDirection), 0.0) + mix(groundColor, skyColor, 0.5 * dot(normal, skyDirection) + 0.5);
    gl_FragColor = vec4(clamp(albedo * light, 0.0, 1.0), 1.0);
}
`;
