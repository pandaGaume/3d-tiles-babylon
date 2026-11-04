/**
 * Shaders of the GPU terrain engine. Every instance draws a predefined normalized grid; its four instance attributes
 * size and place it:
 *
 * - `instPlace`: tile centre minus camera position, computed in double precision on the CPU, and the shape layer;
 * - `instRotation`: cosine and sine of the centre longitude, longitude span of the tile, skirt depth;
 * - `instElevation`: area of the tile in its elevation page, `west, north, size`, and the page layer, `-1` for none;
 * - `instImagery`: area of the tile in its imagery page and the page layer, `-1` for none.
 *
 * `position` holds the normalized `u, v` of the grid vertex and `1` for skirt vertices.
 */
export const INSTANCED_GRID_VERTEX = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2DArray;

attribute vec3 position;
attribute vec4 instPlace;
attribute vec4 instRotation;
attribute vec4 instElevation;
attribute vec4 instImagery;

uniform mat4 viewProjection;
uniform float cells;
uniform float verticalScale;
uniform sampler2DArray shapes;
uniform sampler2DArray elevations;

varying vec3 vNormal;
varying vec3 vImagery;

// Height at tile coordinates, interpolated bilinearly between the heights of the elevation page.
float heightAt(vec2 uv) {
    if (instElevation.w < 0.0) return 0.0;
    float size = float(textureSize(elevations, 0).x);
    vec2 texel = (instElevation.xy + uv * instElevation.z) * (size - 1.0);
    ivec2 base = clamp(ivec2(floor(texel)), ivec2(0), ivec2(int(size) - 2));
    vec2 f = clamp(texel - vec2(base), 0.0, 1.0);
    int layer = int(instElevation.w + 0.5);
    float h00 = texelFetch(elevations, ivec3(base, layer), 0).r;
    float h10 = texelFetch(elevations, ivec3(base + ivec2(1, 0), layer), 0).r;
    float h01 = texelFetch(elevations, ivec3(base + ivec2(0, 1), layer), 0).r;
    float h11 = texelFetch(elevations, ivec3(base + ivec2(1, 1), layer), 0).r;
    return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y) * verticalScale;
}

// Ellipsoid normal of a vertex, in the frame of the shape, where the tile centre longitude is 0.
vec3 ellipsoidNormal(float latitude, float u) {
    float longitude = (u - 0.5) * instRotation.z;
    return vec3(cos(latitude) * cos(longitude), cos(latitude) * sin(longitude), sin(latitude));
}

vec4 shapeAt(ivec2 vertex) {
    return texelFetch(shapes, ivec3(vertex, int(instPlace.w + 0.5)), 0);
}

vec3 surfaceAt(ivec2 vertex) {
    vec4 shape = shapeAt(vertex);
    vec2 uv = vec2(vertex) / cells;
    return shape.xyz + ellipsoidNormal(shape.w, uv.x) * heightAt(uv);
}

// Rotation about the polar axis by the longitude of the tile centre.
vec3 rotate(vec3 p) {
    return vec3(instRotation.x * p.x - instRotation.y * p.y, instRotation.y * p.x + instRotation.x * p.y, p.z);
}

void main(void) {
    int last = int(cells + 0.5);
    ivec2 vertex = ivec2(floor(position.xy * cells + 0.5));
    vec4 shape = shapeAt(vertex);
    vec3 up = ellipsoidNormal(shape.w, position.x);
    vec3 local = shape.xyz + up * (heightAt(position.xy) - position.z * instRotation.w);

    // Normal of the displaced surface, from the neighbours of the vertex in the full grid.
    vec3 eastward = surfaceAt(ivec2(min(vertex.x + 1, last), vertex.y)) - surfaceAt(ivec2(max(vertex.x - 1, 0), vertex.y));
    vec3 northward = surfaceAt(ivec2(vertex.x, max(vertex.y - 1, 0))) - surfaceAt(ivec2(vertex.x, min(vertex.y + 1, last)));
    vec3 normal = normalize(cross(eastward, northward));
    if (dot(normal, up) < 0.0) normal = -normal;

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

uniform vec3 sunDirection;
uniform vec3 baseColor;
uniform float ambient;
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
    float diffuse = max(dot(normalize(vNormal), sunDirection), 0.0);
    gl_FragColor = vec4(albedo * (ambient + (1.0 - ambient) * diffuse), 1.0);
}
`;
