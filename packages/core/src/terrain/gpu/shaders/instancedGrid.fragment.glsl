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
// Height at a tile coordinate in the DEM across an edge of the tile, bilinear, the coordinate running past that edge. The
// fraction of the layer holds the quarter turns of a DEM tile on another cube face. Interpolated varyings hold constants
// up to rounding: 0.125 keeps the layer and the turns.
float heightAcross(vec4 reference, vec2 uv, int last) {
    float w = reference.w + 0.125;
    int turns = int(fract(w) * 4.0);
    vec2 turned = uv;
    if (turns == 1) turned = vec2(1.0 - uv.y, uv.x);
    else if (turns == 2) turned = vec2(1.0 - uv.x, 1.0 - uv.y);
    else if (turns == 3) turned = vec2(uv.y, 1.0 - uv.x);
    vec2 texel = (reference.xy + turned * reference.z) * float(last);
    ivec2 base = clamp(ivec2(floor(texel)), ivec2(0), ivec2(last - 1));
    vec2 f = clamp(texel - vec2(base), 0.0, 1.0);
    int layer = int(floor(w));
    float h00 = texelFetch(elevations, ivec3(base, layer), 0).r;
    float h10 = texelFetch(elevations, ivec3(base + ivec2(1, 0), layer), 0).r;
    float h01 = texelFetch(elevations, ivec3(base + ivec2(0, 1), layer), 0).r;
    float h11 = texelFetch(elevations, ivec3(base + ivec2(1, 1), layer), 0).r;
    return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}

// Whether a reference reads another DEM page than this one: a neighbour not in memory falls back to the page of the tile.
bool otherPage(vec4 reference, int layer) {
    return reference.w >= 0.0 && int(floor(reference.w + 0.125)) != layer;
}

// Gradient of the height per texel at a sample of a DEM page, by central differences. On the edge of the page the sample
// beyond is read in the DEM across, so that both sides of the edge compute the same slope; one-sided when it is not in memory.
vec2 sampleGradient(ivec2 p, vec4 page, int layer, int last) {
    float center = texelFetch(elevations, ivec3(p, layer), 0).r;
    vec2 origin = page.xy;
    float perTexel = 1.0 / (float(last) * page.z);
    vec2 uv = (vec2(p) / float(last) - origin) / page.z;
    float west = center;
    float east = center;
    float north = center;
    float south = center;
    float dx = 0.0;
    float dy = 0.0;
    if (p.x > 0) { west = texelFetch(elevations, ivec3(p.x - 1, p.y, layer), 0).r; dx += 1.0; }
    else if (otherPage(vEdgeW, layer)) { west = heightAcross(vEdgeW, uv - vec2(perTexel, 0.0), last); dx += 1.0; }
    if (p.x < last) { east = texelFetch(elevations, ivec3(p.x + 1, p.y, layer), 0).r; dx += 1.0; }
    else if (otherPage(vEdgeE, layer)) { east = heightAcross(vEdgeE, uv + vec2(perTexel, 0.0), last); dx += 1.0; }
    if (p.y > 0) { north = texelFetch(elevations, ivec3(p.x, p.y - 1, layer), 0).r; dy += 1.0; }
    else if (otherPage(vEdgeN, layer)) { north = heightAcross(vEdgeN, uv - vec2(0.0, perTexel), last); dy += 1.0; }
    if (p.y < last) { south = texelFetch(elevations, ivec3(p.x, p.y + 1, layer), 0).r; dy += 1.0; }
    else if (otherPage(vEdgeS, layer)) { south = heightAcross(vEdgeS, uv + vec2(0.0, perTexel), last); dy += 1.0; }
    return vec2((east - west) / dx, (south - north) / dy);
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
    vec2 top = mix(sampleGradient(base, page, layer, last), sampleGradient(base + ivec2(1, 0), page, layer, last), f.x);
    vec2 bottom = mix(sampleGradient(base + ivec2(0, 1), page, layer, last), sampleGradient(base + ivec2(1, 1), page, layer, last), f.x);
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
    // cell shows, and both sides of a tile edge read the same slope. Its page must hold the samples of the source: levels
    // interpolated below it have a slope constant by parts, which shows as a checkerboard.
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
