import { Constants } from "@babylonjs/core/Engines/constants.js";
import "@babylonjs/core/Engines/Extensions/engine.rawTexture.js";
import { RegisterBaseTexturePolynomial } from "@babylonjs/core/Materials/Textures/baseTexture.polynomial.pure.js";
import { RawCubeTexture } from "@babylonjs/core/Materials/Textures/rawCubeTexture.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { ICartesian3 } from "@spacexr/tiles";

import settings from "./objects-environment.json";

/** Direction of a point of a cube face, from `-1` to `1` along the axes of the face, in the order of the faces of a cube map. */
const FACE_DIRECTIONS: readonly ((
    u: number,
    v: number,
) => readonly [number, number, number])[] = [
    (u, v) => [1, -v, -u],
    (u, v) => [-1, -v, u],
    (u, v) => [u, 1, v],
    (u, v) => [u, -1, -v],
    (u, v) => [u, -v, 1],
    (u, v) => [-u, -v, -1],
];

/** The faces of a cube map as RGBA bytes: the ground below the horizon of a place, the sky above it, a blend between them. */
function horizonFaces(up: Readonly<ICartesian3>): Uint8Array[] {
    const { faceCells, ground, horizonWidth, sky } = settings;
    const length = Math.hypot(up.x, up.y, up.z);
    return FACE_DIRECTIONS.map((direction) => {
        const face = new Uint8Array(faceCells * faceCells * 4);
        for (let row = 0; row < faceCells; row++) {
            for (let column = 0; column < faceCells; column++) {
                const [x, y, z] = direction(
                    ((column + 0.5) / faceCells) * 2 - 1,
                    ((row + 0.5) / faceCells) * 2 - 1,
                );
                const elevation =
                    (x * up.x + y * up.y + z * up.z) /
                    (length * Math.hypot(x, y, z));
                const blend = Math.min(
                    Math.max(
                        (elevation + horizonWidth) / (2 * horizonWidth),
                        0,
                    ),
                    1,
                );
                const texel = (row * faceCells + column) * 4;
                for (let channel = 0; channel < 3; channel++) {
                    const value =
                        ground[channel]! +
                        (sky[channel]! - ground[channel]!) * blend;
                    face[texel + channel] = Math.round(value * 255);
                }
                face[texel + 3] = 255;
            }
        }
        return face;
    });
}

/**
 * Gives the glTF objects of this example a horizon to reflect, made without any file: metals are black without an
 * environment. Like the lights of the example, it holds for one place. The terrain reads no environment.
 */
export function addObjectsEnvironment(
    scene: Scene,
    up: Readonly<ICartesian3>,
): void {
    // The diffuse light of the environment comes from this polynomial, which the materials do not register themselves.
    RegisterBaseTexturePolynomial();
    const texture = new RawCubeTexture(
        scene,
        horizonFaces(up),
        settings.faceCells,
        Constants.TEXTUREFORMAT_RGBA,
        Constants.TEXTURETYPE_UNSIGNED_BYTE,
        true,
        false,
        Constants.TEXTURE_TRILINEAR_SAMPLINGMODE,
    );
    texture.name = "objects-environment";
    texture.gammaSpace = true;
    // Rough materials read blurrier levels of the texture.
    texture.lodGenerationScale = settings.lodGenerationScale;
    // The faces are written in the axes of the scene: no mirror for the right-handed system.
    texture.invertZ = true;
    scene.environmentTexture = texture;
    scene.environmentIntensity = settings.intensity;
}
