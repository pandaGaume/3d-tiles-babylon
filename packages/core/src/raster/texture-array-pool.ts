import { Constants } from "@babylonjs/core/Engines/constants.js";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine.js";
import { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture.js";
import { InternalTexture, InternalTextureSource } from "@babylonjs/core/Materials/Textures/internalTexture.js";
import { Observable } from "@babylonjs/core/Misc/observable.js";
import type { Scene } from "@babylonjs/core/scene.js";

/** WebGL 2 members of the Babylon engine used to address single layers of a texture array. */
interface IWebGL2TextureEngine extends AbstractEngine {
    _gl: WebGL2RenderingContext;
    _bindTextureDirectly(target: number, texture: InternalTexture | null, forTextureDataUpdate?: boolean, force?: boolean): boolean;
}

export interface ITextureArrayPoolOptions {
    /** Width and height of every layer, in texels. */
    size: number;
    /** Layers allocated at creation. Defaults to 64. */
    initialLayers?: number;
    /** Growth factor applied when the pool is full. Defaults to 1.5. */
    growth?: number;
    /**
     * Texel format. `rgba8` (default) holds colours, filtered bilinearly and copied on the GPU when the pool grows.
     * `rgba32f` holds data read with `texelFetch`, such as indirection tables; it is not filtered and not copied when
     * the pool grows, since copying float layers needs `EXT_color_buffer_float`: owners write their layers again on
     * `onGrowObservable`.
     */
    format?: "rgba8" | "rgba32f";
}

/**
 * Pool of pages stored in one WebGL 2 texture array, ported from the SpaceXR `Texture3`.
 *
 * Each page is one layer, written alone with `texSubImage3D`, which Babylon's `RawTexture2DArray` cannot do: it only
 * uploads the whole array. When every layer is used, the pool grows into a larger array and copies the layers on the
 * GPU. Pages are sampled with bilinear filtering and clamped to their edges; shaders select the page with the third
 * texture coordinate.
 */
export class TextureArrayPool extends BaseTexture {
    public readonly size: number;
    public readonly format: "rgba8" | "rgba32f";
    /** Notified after the pool grew. Layers of an `rgba32f` pool must then be written again. */
    public readonly onGrowObservable = new Observable<TextureArrayPool>();
    private readonly growth: number;
    private readonly free: number[] = [];
    private layers: number;
    private used = 0;

    public constructor(scene: Scene, options: ITextureArrayPoolOptions) {
        super(scene);
        const engine = scene.getEngine();
        const gl = (engine as Partial<IWebGL2TextureEngine>)._gl;
        if (typeof gl?.texStorage3D !== "function") throw new Error("TextureArrayPool requires a WebGL 2 engine.");
        if (!Number.isInteger(options.size) || options.size < 1) throw new RangeError("The page size must be a positive integer.");
        this.size = options.size;
        this.format = options.format ?? "rgba8";
        this.growth = Math.max(options.growth ?? 1.5, 1.1);
        this.layers = Math.max(1, options.initialLayers ?? 64);
        this.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        this.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        this._texture = this.createArray(this.layers);
        for (let layer = this.layers - 1; layer >= 0; layer--) this.free.push(layer);
    }

    /** Layers allocated on the GPU. */
    public get capacity(): number {
        return this.layers;
    }

    /** Layers holding a page. */
    public get count(): number {
        return this.used;
    }

    /** Bytes allocated on the GPU. */
    public get gpuBytes(): number {
        return this.layers * this.size * this.size * (this.format === "rgba32f" ? 16 : 4);
    }

    public override getClassName(): string {
        return "TextureArrayPool";
    }

    /**
     * Reserves a layer, growing the array when it is full.
     *
     * @returns The layer, or `undefined` when the device texture array limit is reached.
     */
    public reserve(): number | undefined {
        if (this.free.length === 0 && !this.grow()) return undefined;
        this.used++;
        return this.free.pop();
    }

    /** Returns a layer to the pool. Its texels stay until the layer is written again. */
    public release(layer: number): void {
        if (layer < 0 || layer >= this.layers || this.free.includes(layer)) return;
        this.free.push(layer);
        this.used--;
    }

    /**
     * Writes texels into a layer, by default the whole page.
     *
     * @param data - `width * height * 4` values, rows from the top of the page: bytes for `rgba8`, floats for
     *     `rgba32f`.
     */
    public write(layer: number, data: ArrayBufferView, x = 0, y = 0, width = this.size, height = this.size): void {
        const texture = this._texture;
        if (!texture) return;
        const engine = this.webgl();
        const gl = engine._gl;
        engine._bindTextureDirectly(gl.TEXTURE_2D_ARRAY, texture, true);
        this.withUnpackDefaults(gl, () =>
            gl.texSubImage3D(
                gl.TEXTURE_2D_ARRAY,
                0,
                x,
                y,
                layer,
                width,
                height,
                1,
                gl.RGBA,
                this.format === "rgba32f" ? gl.FLOAT : gl.UNSIGNED_BYTE,
                data,
            ),
        );
        engine._bindTextureDirectly(gl.TEXTURE_2D_ARRAY, null);
    }

    private webgl(): IWebGL2TextureEngine {
        return this._getEngine() as IWebGL2TextureEngine;
    }

    private createArray(layers: number): InternalTexture {
        const engine = this.webgl();
        const gl = engine._gl;
        const texture = new InternalTexture(engine, InternalTextureSource.Raw2DArray);
        texture.baseWidth = texture.width = this.size;
        texture.baseHeight = texture.height = this.size;
        texture.baseDepth = texture.depth = layers;
        texture.is2DArray = true;
        texture.format = Constants.TEXTUREFORMAT_RGBA;
        const float = this.format === "rgba32f";
        texture.type = float ? Constants.TEXTURETYPE_FLOAT : Constants.TEXTURETYPE_UNSIGNED_BYTE;
        texture.samplingMode = float ? Constants.TEXTURE_NEAREST_SAMPLINGMODE : Constants.TEXTURE_BILINEAR_SAMPLINGMODE;
        texture.generateMipMaps = false;
        engine._bindTextureDirectly(gl.TEXTURE_2D_ARRAY, texture, true);
        gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, float ? gl.RGBA32F : gl.RGBA8, this.size, this.size, layers);
        const filter = float ? gl.NEAREST : gl.LINEAR;
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        engine._bindTextureDirectly(gl.TEXTURE_2D_ARRAY, null);
        texture.isReady = true;
        return texture;
    }

    /** Moves the pages into a larger array; `false` when the device limit is reached. */
    private grow(): boolean {
        const engine = this.webgl();
        const old = this._texture;
        if (!old) return false;
        const limit = engine.getCaps().texture2DArrayMaxLayerCount || 256;
        const layers = Math.min(limit, Math.max(this.layers + 1, Math.ceil(this.layers * this.growth)));
        if (layers <= this.layers) return false;

        const texture = this.createArray(layers);
        if (this.format === "rgba32f") {
            old.dispose();
            this._texture = texture;
            for (let layer = layers - 1; layer >= this.layers; layer--) this.free.push(layer);
            this.layers = layers;
            this.onGrowObservable.notifyObservers(this);
            return true;
        }
        const gl = engine._gl;
        // Copy each layer through a framebuffer, then restore the bindings Babylon expects.
        const previous = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
        const framebuffer = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        engine._bindTextureDirectly(gl.TEXTURE_2D_ARRAY, texture, true);
        const source = old._hardwareTexture?.underlyingResource as WebGLTexture | undefined;
        for (let layer = 0; source && layer < this.layers; layer++) {
            gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, source, 0, layer);
            if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) continue;
            gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, 0, 0, this.size, this.size);
        }
        engine._bindTextureDirectly(gl.TEXTURE_2D_ARRAY, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, previous);
        gl.deleteFramebuffer(framebuffer);

        old.dispose();
        this._texture = texture;
        for (let layer = layers - 1; layer >= this.layers; layer--) this.free.push(layer);
        this.layers = layers;
        this.onGrowObservable.notifyObservers(this);
        return true;
    }

    public override dispose(): void {
        this.onGrowObservable.clear();
        super.dispose();
    }

    /** Runs an upload with the default unpack state, then restores the state Babylon set. */
    private withUnpackDefaults(gl: WebGL2RenderingContext, upload: () => void): void {
        const flipY = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL) as boolean;
        const premultiply = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL) as boolean;
        const alignment = gl.getParameter(gl.UNPACK_ALIGNMENT) as number;
        if (flipY) gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        if (premultiply) gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        if (alignment !== 4) gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
        try {
            upload();
        } finally {
            if (flipY) gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
            if (premultiply) gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
            if (alignment !== 4) gl.pixelStorei(gl.UNPACK_ALIGNMENT, alignment);
        }
    }
}
