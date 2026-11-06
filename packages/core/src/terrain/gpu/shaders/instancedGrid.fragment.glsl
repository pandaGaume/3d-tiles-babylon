// Fragment shader of the GPU terrain engine: imagery, then the normal and the lighting of the surface.

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
