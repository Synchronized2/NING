const { Live2DRenderer } = require("./renderer");
const { loadModelBuffer } = require("./model");
const TEXTURES = [
  "/assets/live2d/hiyori/texture_00.png",
  "/assets/live2d/hiyori/texture_01.png",
];

Component({
  properties: {
    active: { type: Boolean, value: true, observer: "onActiveChange" },
    state: { type: String, value: "idle", observer: "onStateChange" },
    speaking: { type: Boolean, value: false, observer: "onSpeakingChange" },
  },

  data: {
    status: "loading",
    statusText: "正在加载互动形象",
    viewMode: "portrait",
  },

  lifetimes: {
    ready() {
      this.initialize();
    },
    detached() {
      this.dispose();
    },
  },

  pageLifetimes: {
    show() {
      this._pageVisible = true;
      this.startLoop();
    },
    hide() {
      this._pageVisible = false;
      this.stopLoop();
    },
  },

  methods: {
    async initialize() {
      if (this._initializing || this._renderer) return;
      const attempt = {};
      this._initializing = attempt;
      this.setData({ status: "loading", statusText: "正在加载互动形象" });
      try {
        const result = await new Promise((resolve, reject) => {
          this.createSelectorQuery().select("#live2d-canvas").fields({ node: true, size: true }).exec((items) => {
            const item = items && items[0];
            if (item && item.node && item.width && item.height) resolve(item);
            else reject(new Error("无法创建 WebGL 画布"));
          });
        });
        if (this._initializing !== attempt) return;
        const canvas = result.node;
        const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
        const pixelRatio = Math.min(2, Number(info.pixelRatio) || 1);
        canvas.width = Math.max(1, Math.round(result.width * pixelRatio));
        canvas.height = Math.max(1, Math.round(result.height * pixelRatio));
        const gl = canvas.getContext("webgl", {
          alpha: true,
          antialias: true,
          premultipliedAlpha: true,
          preserveDrawingBuffer: false,
          stencil: true,
        });
        if (!gl) throw new Error("当前设备不支持 WebGL");
        const modelBuffer = loadModelBuffer();
        if (this._initializing !== attempt) return;
        this._canvas = canvas;
        const renderer = new Live2DRenderer({
          canvas,
          gl,
          modelBuffer,
          textureSources: TEXTURES,
          width: canvas.width,
          height: canvas.height,
        });
        this._renderer = renderer;
        await renderer.initialize();
        if (this._initializing !== attempt) {
          renderer.destroy();
          return;
        }
        this._renderer.setState(this.properties.state);
        this._renderer.setSpeaking(this.properties.speaking);
        this._renderer.setViewMode(this.data.viewMode);
        // iOS may defer the first requestAnimationFrame for a newly mounted canvas.
        // Draw once before removing the loading state so a ready avatar is never blank.
        this._renderer.draw(Date.now());
        gl.flush();
        const renderError = gl.getError();
        if (renderError !== gl.NO_ERROR) throw new Error(`WebGL 首帧绘制失败（${renderError}）`);
        this.setData({ status: "ready", statusText: "" });
        this.triggerEvent("ready");
        this.startLoop();
      } catch (error) {
        if (this._initializing !== attempt) return;
        this.disposeRenderer();
        const message = String(error && error.message || "互动形象加载失败").replace(/\s+/g, " ").slice(0, 80);
        this.setData({ status: "error", statusText: message });
        this.triggerEvent("error", { message });
      } finally {
        if (this._initializing === attempt) this._initializing = false;
      }
    },

    retry() {
      this.disposeRenderer();
      this.initialize();
    },

    onActiveChange(active) {
      if (active) this.startLoop();
      else this.stopLoop();
    },

    onStateChange(state) {
      if (this._renderer) this._renderer.setState(state);
    },

    onSpeakingChange(speaking) {
      if (this._renderer) this._renderer.setSpeaking(speaking);
    },

    onTouch(event) {
      if (!this._renderer || !event.touches || !event.touches[0]) return;
      const touch = event.touches[0];
      const x = Number(touch.x !== undefined ? touch.x : touch.clientX);
      const y = Number(touch.y !== undefined ? touch.y : touch.clientY);
      const width = Number(this._canvas && this._canvas.width) || 1;
      const height = Number(this._canvas && this._canvas.height) || 1;
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      const pixelRatio = Math.min(2, Number(info.pixelRatio) || 1);
      this._renderer.setFocus(x * pixelRatio / width * 2 - 1, y * pixelRatio / height * 2 - 1);
    },

    onTouchEnd() {
      if (this._renderer) this._renderer.releaseFocus();
    },

    onTap() {
      if (this._renderer) this._renderer.triggerGesture();
      this.triggerEvent("interact");
    },

    toggleViewMode() {
      const viewMode = this.data.viewMode === "portrait" ? "full" : "portrait";
      if (this._renderer) this._renderer.setViewMode(viewMode);
      this.setData({ viewMode });
    },

    startLoop() {
      if (!this._renderer || this._frame || !this.properties.active || this._pageVisible === false) return;
      const render = () => {
        this._frame = null;
        if (!this._renderer || !this.properties.active || this._pageVisible === false) return;
        try {
          this._renderer.draw(Date.now());
        } catch (error) {
          this.setData({ status: "error", statusText: "互动形象渲染失败，请重试" });
          this.triggerEvent("error", { message: error.message });
          return;
        }
        this._frame = this._canvas.requestAnimationFrame(render);
      };
      this._frame = this._canvas.requestAnimationFrame(render);
    },

    stopLoop() {
      if (!this._frame || !this._canvas) return;
      this._canvas.cancelAnimationFrame(this._frame);
      this._frame = null;
    },

    disposeRenderer() {
      this.stopLoop();
      if (this._renderer) this._renderer.destroy();
      this._renderer = null;
      this._canvas = null;
    },

    dispose() {
      this._initializing = false;
      this.disposeRenderer();
    },
  },
});
