/**
 * Shaders of the GPU terrain engine. Every instance draws the same predefined grid, refined on its edges; its
 * instance attributes size and place it:
 *
 * - `instPlace`: tile centre minus camera position, computed in double precision on the CPU, and the shape layer;
 * - `instRotation`: cosine and sine of the centre longitude and longitude span of the tile, or with radial heights the
 *   tile centre on the body, and the bits of the edges whose neighbours are finer, N 1, E 2, S 4, W 8;
 * - `instImagery`: area of the tile in its imagery page, `west, north, size`, and the page layer, `-1` for none;
 * - `instElevation`, `instEdge*`, `instCorner*`: area of the tile in a DEM tile and the layer of its page, `-1` for
 *   none, for the interior, each edge and each corner. The fraction of the layer holds the quarter turns of a DEM tile
 *   on another cube face.
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

varying vec3 vImagery;
#ifdef RADIAL_HEIGHTS
// Inverse squared radii of the reference surface.
uniform vec3 inverseRadiiSquared;
varying vec2 vTile;
varying vec4 vPage;
varying vec3 vUp;
varying vec3 vEast;
varying vec3 vSouth;
#else
varying vec3 vNormal;
#endif

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
    int turns = int(fract(reference.w) * 4.0 + 0.5);
    vec2 turned = uv;
    if (turns == 1) turned = vec2(1.0 - uv.y, uv.x);
    else if (turns == 2) turned = vec2(1.0 - uv.x, 1.0 - uv.y);
    else if (turns == 3) turned = vec2(uv.y, 1.0 - uv.x);
    vec2 texel = (reference.xy + turned * reference.z) * (size - 1.0);
    ivec2 base = clamp(ivec2(floor(texel)), ivec2(0), ivec2(int(size) - 2));
    vec2 f = clamp(texel - vec2(base), 0.0, 1.0);
    int layer = int(floor(reference.w));
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
#ifdef RADIAL_HEIGHTS
    vec3 up = normalize(instRotation.xyz + shape.xyz);
#else
    float longitude = (uv.x - 0.5) * instRotation.z;
    vec3 up = vec3(cos(shape.w) * cos(longitude), cos(shape.w) * sin(longitude), sin(shape.w));
#endif
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

#ifdef RADIAL_HEIGHTS
// Position of a lattice point on the reference surface, relative to the tile centre.
vec3 shapePosition(ivec2 h) {
    return texelFetch(shapes, ivec3(h, int(instPlace.w + 0.5)), 0).xyz;
}

// Tangent of the reference surface per unit of tile coordinate, along the chord between two lattice points clamped to
// the tile. A chord one-sided at a tile edge leans by half a cell of curvature: its projection on the tangent plane does
// not, so both sides of an edge agree.
vec3 surfaceTangent(ivec2 before, ivec2 after, vec3 normal) {
    int last = steps();
    ivec2 first = clamp(before, ivec2(0), ivec2(last));
    ivec2 second = clamp(after, ivec2(0), ivec2(last));
    vec3 chord = (shapePosition(second) - shapePosition(first)) * float(last) / float(second.x - first.x + second.y - first.y);
    return chord - normal * dot(chord, normal);
}
#endif

// Rotation about the polar axis by the longitude of the tile centre.
vec3 rotate(vec3 p) {
#ifdef RADIAL_HEIGHTS
    return p;
#else
    return vec3(instRotation.x * p.x - instRotation.y * p.y, instRotation.y * p.x + instRotation.x * p.y, p.z);
#endif
}

void main(void) {
    ivec2 h = ivec2(floor(position.xy * float(steps()) + 0.5));
    vec3 local = positionAt(h);

#ifdef RADIAL_HEIGHTS
    // The fragment stage computes the normal from the DEM: it needs the tangents of the reference surface and the page.
    vec3 body = instRotation.xyz + shapePosition(h);
    vec3 surfaceNormal = normalize(body * inverseRadiiSquared);
    vUp = normalize(body);
    vEast = surfaceTangent(h - ivec2(2, 0), h + ivec2(2, 0), surfaceNormal);
    vSouth = surfaceTangent(h - ivec2(0, 2), h + ivec2(0, 2), surfaceNormal);
    vTile = position.xy;
    vPage = instElevation;
#else
    // Normal of the displaced surface, from the neighbours one cell away, clamped to the tile: east cross north.
    vec3 eastward = positionAt(h + ivec2(2, 0)) - positionAt(h - ivec2(2, 0));
    vec3 northward = positionAt(h - ivec2(0, 2)) - positionAt(h + ivec2(0, 2));
    vec3 normal = normalize(cross(eastward, northward));
    vNormal = rotate(normal);
#endif
    vImagery = vec3(instImagery.xy + position.xy * instImagery.z, instImagery.w);
    gl_Position = viewProjection * vec4(rotate(local) + instPlace.xyz, 1.0);
}
`;

export const INSTANCED_GRID_FRAGMENT = /* glsl */ `
precision highp float;
precision highp sampler2DArray;

varying vec3 vImagery;
#ifdef RADIAL_HEIGHTS
varying vec2 vTile;
varying vec4 vPage;
varying vec3 vUp;
varying vec3 vEast;
varying vec3 vSouth;
uniform sampler2DArray elevations;
uniform float verticalScale;
#else
varying vec3 vNormal;
#endif

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

#ifdef RADIAL_HEIGHTS
// Gradient of the height per texel at a sample of a DEM page: central differences, one-sided on the edges of the page.
vec2 sampleGradient(ivec2 p, int layer, int last) {
    ivec2 low = max(p - ivec2(1), ivec2(0));
    ivec2 high = min(p + ivec2(1), ivec2(last));
    float west = texelFetch(elevations, ivec3(low.x, p.y, layer), 0).r;
    float east = texelFetch(elevations, ivec3(high.x, p.y, layer), 0).r;
    float north = texelFetch(elevations, ivec3(p.x, low.y, layer), 0).r;
    float south = texelFetch(elevations, ivec3(p.x, high.y, layer), 0).r;
    return vec2((east - west) / float(high.x - low.x), (south - north) / float(high.y - low.y));
}

// Gradient of the height per unit of tile coordinate, at a point of a DEM page: the gradients of its four nearest samples
// interpolated, so that lighting stays smooth across the cells of the DEM.
vec2 heightGradient(vec4 page, vec2 uv) {
    if (page.w < 0.0) return vec2(0.0);
    int last = textureSize(elevations, 0).x - 1;
    vec2 texel = (page.xy + uv * page.z) * float(last);
    ivec2 base = clamp(ivec2(floor(texel)), ivec2(0), ivec2(last - 1));
    vec2 f = clamp(texel - vec2(base), 0.0, 1.0);
    int layer = int(floor(page.w + 0.5));
    vec2 top = mix(sampleGradient(base, layer, last), sampleGradient(base + ivec2(1, 0), layer, last), f.x);
    vec2 bottom = mix(sampleGradient(base + ivec2(0, 1), layer, last), sampleGradient(base + ivec2(1, 1), layer, last), f.x);
    return mix(top, bottom, f.y) * page.z * float(last) * verticalScale;
}
#endif

void main(void) {
    vec3 albedo = baseColor;
#ifdef IMAGERY
    if (vImagery.z >= 0.0) {
        // Point registration: page coordinate t lies at the centre of texel t * (size - 1).
        vec2 uv = (clamp(vImagery.xy, 0.0, 1.0) * (imagerySize - 1.0) + 0.5) / imagerySize;
        // No mipmaps: an explicit level is the same colour, and allowed in non-uniform control flow on WebGPU.
        albedo = textureLod(imagery, vec3(uv, floor(vImagery.z + 0.5)), 0.0).rgb;
    }
#endif
#ifdef RADIAL_HEIGHTS
    // The normal of the displaced surface reads the DEM at each pixel, not the vertices of the grid: relief finer than a
    // cell shows, and both sides of a tile edge read the same slope.
    vec3 up = normalize(vUp);
    vec2 gradient = heightGradient(vPage, vTile);
    vec3 normal = normalize(cross(vEast + up * gradient.x, -(vSouth + up * gradient.y)));
#else
    vec3 normal = normalize(vNormal);
#endif
    // The lighting of the Babylon standard material, without specular.
    vec3 light = sunColor * max(dot(normal, sunDirection), 0.0) + mix(groundColor, skyColor, 0.5 * dot(normal, skyDirection) + 0.5);
    gl_FragColor = vec4(clamp(albedo * light, 0.0, 1.0), 1.0);
}
`;
