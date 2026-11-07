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
varying vec4 vEdgeN;
varying vec4 vEdgeE;
varying vec4 vEdgeS;
varying vec4 vEdgeW;
uniform sampler2DArray elevations;
uniform float verticalScale;
uniform float cells;
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
// Central differences include the one-sample gutter copied from resident neighbour DEMs.
vec2 sampleGradient(ivec2 p, int layer) {
    p += ivec2(1);
    float west = texelFetch(elevations, ivec3(p - ivec2(1, 0), layer), 0).r;
    float east = texelFetch(elevations, ivec3(p + ivec2(1, 0), layer), 0).r;
    float north = texelFetch(elevations, ivec3(p - ivec2(0, 1), layer), 0).r;
    float south = texelFetch(elevations, ivec3(p + ivec2(0, 1), layer), 0).r;
    return 0.5 * vec2(east - west, south - north);
}
// Gradient of the height per unit of tile coordinate, at a point of a DEM page: the gradients of its four nearest samples
// interpolated, so that lighting stays smooth across the cells of the DEM.
vec2 heightGradient(vec4 page, vec2 uv) {
    if (page.w < 0.0) return vec2(0.0);
    int last = textureSize(elevations, 0).x - 3;
    int turns = int(fract(page.w + 0.125) * 4.0);
    if (turns == 1) uv = vec2(1.0 - uv.y, uv.x);
    else if (turns == 2) uv = vec2(1.0 - uv.x, 1.0 - uv.y);
    else if (turns == 3) uv = vec2(uv.y, 1.0 - uv.x);
    vec2 texel = (page.xy + uv * page.z) * float(last);
    ivec2 base = clamp(ivec2(floor(texel)), ivec2(0), ivec2(last - 1));
    vec2 f = clamp(texel - vec2(base), 0.0, 1.0);
    int layer = int(floor(page.w + 0.125));
    vec2 top = mix(sampleGradient(base, layer), sampleGradient(base + ivec2(1, 0), layer), f.x);
    vec2 bottom = mix(sampleGradient(base + ivec2(0, 1), layer), sampleGradient(base + ivec2(1, 1), layer), f.x);
    vec2 gradient = mix(top, bottom, f.y) * page.z * float(last) * verticalScale;
    if (turns == 1) gradient = vec2(gradient.y, -gradient.x);
    else if (turns == 2) gradient = -gradient;
    else if (turns == 3) gradient = vec2(-gradient.y, gradient.x);
    return gradient;
}

// Geometry joins the coarsest DEM on an edge. Its normal must follow that same surface,
// fading into the interior over one grid cell instead of switching DEM gradients abruptly.
vec2 joinedGradient(vec2 uv) {
    vec2 gradient = heightGradient(vPage, uv);
    float width = 1.0 / cells;
    if (uv.y < width && vEdgeN.w >= 0.0 && abs(vEdgeN.w - vPage.w) > 0.125)
        gradient = mix(heightGradient(vEdgeN, uv), gradient, smoothstep(0.0, width, uv.y));
    if (1.0 - uv.x < width && vEdgeE.w >= 0.0 && abs(vEdgeE.w - vPage.w) > 0.125)
        gradient = mix(heightGradient(vEdgeE, uv), gradient, smoothstep(0.0, width, 1.0 - uv.x));
    if (1.0 - uv.y < width && vEdgeS.w >= 0.0 && abs(vEdgeS.w - vPage.w) > 0.125)
        gradient = mix(heightGradient(vEdgeS, uv), gradient, smoothstep(0.0, width, 1.0 - uv.y));
    if (uv.x < width && vEdgeW.w >= 0.0 && abs(vEdgeW.w - vPage.w) > 0.125)
        gradient = mix(heightGradient(vEdgeW, uv), gradient, smoothstep(0.0, width, uv.x));
    return gradient;
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
    // cell shows, and both sides of a tile edge read the same slope. Its page must hold the samples of the source: levels
    // interpolated below it have a slope constant by parts, which shows as a checkerboard.
    vec3 up = normalize(vUp);
    vec2 gradient = joinedGradient(vTile);
    vec3 normal = normalize(cross(vEast + up * gradient.x, -(vSouth + up * gradient.y)));
#else
    vec3 normal = normalize(vNormal);
#endif
    // The lighting of the Babylon standard material, without specular.
    vec3 light = sunColor * max(dot(normal, sunDirection), 0.0) + mix(groundColor, skyColor, 0.5 * dot(normal, skyDirection) + 0.5);
    gl_FragColor = vec4(clamp(albedo * light, 0.0, 1.0), 1.0);
}
