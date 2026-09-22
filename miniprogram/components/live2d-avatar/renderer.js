const runtime = require("../../vendor/live2d/live2dcubismcore.min.js").Live2DCubismCore;
const POSE_GROUPS = [["PartArmA", "PartArmB"]];

const VERTEX_SHADER = `
  attribute vec2 aPosition;
  attribute vec2 aUv;
  uniform vec4 uTransform;
  varying vec2 vUv;
  void main() {
    vec2 position = aPosition * uTransform.xy + uTransform.zw;
    gl_Position = vec4(position, 0.0, 1.0);
    vUv = aUv;
  }
`;

const FRAGMENT_SHADER = `
  precision mediump float;
  uniform sampler2D uTexture;
  uniform float uOpacity;
  uniform float uMaskPass;
  varying vec2 vUv;
  void main() {
    vec4 color = texture2D(uTexture, vUv);
    if (uMaskPass > 0.5) {
      if (color.a * uOpacity < 0.02) discard;
      gl_FragColor = vec4(1.0);
      return;
    }
    gl_FragColor = color * uOpacity;
  }
`;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "着色器编译失败";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function createProgram(gl) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || "着色器链接失败";
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
}

function loadTexture(canvas, gl, source, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const image = canvas.createImage();
    let settled = false;
    const complete = (done, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      image.onload = null;
      image.onerror = null;
      done(value);
    };
    const timeout = setTimeout(() => complete(reject, new Error(`人物纹理加载超时：${source}`)), timeoutMs);
    image.onload = () => {
      try {
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        complete(resolve, texture);
      } catch (error) {
        complete(reject, error);
      }
    };
    image.onerror = () => complete(reject, new Error(`无法加载人物纹理：${source}`));
    image.src = source;
  });
}

function waitForRuntime(timeout = 5000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const inspect = () => {
      try {
        runtime.Version.csmGetVersion();
        resolve();
      } catch (error) {
        if (Date.now() - started >= timeout) reject(new Error("Live2D Core 初始化超时"));
        else setTimeout(inspect, 25);
      }
    };
    inspect();
  });
}

function blendMode(gl, flags) {
  const utils = runtime.Utils;
  if (utils.hasBlendAdditiveBit(flags)) return [gl.ONE, gl.ONE];
  if (utils.hasBlendMultiplicativeBit(flags)) return [gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA];
  return [gl.ONE, gl.ONE_MINUS_SRC_ALPHA];
}

function blinkValue(timeSeconds) {
  const phase = timeSeconds % 4.4;
  if (phase < 3.98) return 1;
  if (phase < 4.08) return 1 - (phase - 3.98) / 0.1;
  if (phase < 4.14) return 0;
  if (phase < 4.28) return (phase - 4.14) / 0.14;
  return 1;
}

function initializePose(model, groups = POSE_GROUPS) {
  // Core starts both alternative arms opaque. The sample pose selects the first.
  for (const group of groups) {
    group.forEach((partId, index) => {
      const opacity = index === 0 ? 1 : 0;
      const partIndex = model.parts.ids.indexOf(partId);
      if (partIndex >= 0) model.parts.opacities[partIndex] = opacity;
    });
  }
}

function visibleBounds(model) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const drawables = model.drawables;
  for (let index = 0; index < drawables.count; index += 1) {
    if (drawables.opacities[index] <= 0.001 || !drawables.indexCounts[index]) continue;
    const vertices = drawables.vertexPositions[index];
    for (let vertex = 0; vertex < vertices.length; vertex += 2) {
      minX = Math.min(minX, vertices[vertex]);
      maxX = Math.max(maxX, vertices[vertex]);
      minY = Math.min(minY, vertices[vertex + 1]);
      maxY = Math.max(maxY, vertices[vertex + 1]);
    }
  }
  if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) throw new Error("人物模型没有可见网格");
  return { minX, maxX, minY, maxY };
}

function fullBodyTransform(model, width, height) {
  const { minX, maxX, minY, maxY } = visibleBounds(model);
  // Fit visible geometry, not the export canvas, and leave room for head motion.
  const scale = Math.min(width * 0.84 / (maxX - minX), height * 0.84 / (maxY - minY));
  const scaleX = 2 * scale / width;
  const scaleY = 2 * scale / height;
  return [scaleX, scaleY, -(minX + maxX) / 2 * scaleX, -(minY + maxY) / 2 * scaleY];
}

function portraitTransform(model, width, height) {
  const { minX, maxX, minY, maxY } = visibleBounds(model);
  const fullScale = Math.min(width * 0.84 / (maxX - minX), height * 0.84 / (maxY - minY));
  const scale = fullScale * 1.5;
  const scaleX = 2 * scale / width;
  const scaleY = 2 * scale / height;
  // Keep the top of the hair inside the same safe area and crop from the feet upward.
  return [scaleX, scaleY, -(minX + maxX) / 2 * scaleX, 0.84 - maxY * scaleY];
}

class Live2DRenderer {
  constructor(options) {
    this.canvas = options.canvas;
    this.gl = options.gl;
    this.modelBuffer = options.modelBuffer;
    this.textureSources = options.textureSources;
    this.poseGroups = options.poseGroups === undefined ? POSE_GROUPS : options.poseGroups;
    this.width = options.width;
    this.height = options.height;
    this.state = "idle";
    this.viewMode = "portrait";
    this.speaking = false;
    this.focusX = 0;
    this.focusY = 0;
    this.targetFocusX = 0;
    this.targetFocusY = 0;
    this.gestureStartedAt = 0;
    this.startedAt = Date.now();
    this.destroyed = false;
  }

  async initialize() {
    await waitForRuntime();
    if (this.destroyed) return this;
    const gl = this.gl;
    this.program = createProgram(gl);
    this.locations = {
      position: gl.getAttribLocation(this.program, "aPosition"),
      uv: gl.getAttribLocation(this.program, "aUv"),
      transform: gl.getUniformLocation(this.program, "uTransform"),
      texture: gl.getUniformLocation(this.program, "uTexture"),
      opacity: gl.getUniformLocation(this.program, "uOpacity"),
      maskPass: gl.getUniformLocation(this.program, "uMaskPass"),
    };
    this.positionBuffer = gl.createBuffer();
    this.uvBuffer = gl.createBuffer();
    this.indexBuffer = gl.createBuffer();
    this.moc = runtime.Moc.fromArrayBuffer(this.modelBuffer);
    if (!this.moc) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (this.destroyed) return this;
      this.moc = runtime.Moc.fromArrayBuffer(this.modelBuffer);
    }
    if (!this.moc) {
      const bytes = new Uint8Array(this.modelBuffer);
      const header = Array.from(bytes.subarray(0, 4), (value) => String.fromCharCode(value)).join("");
      throw new Error(`Cubism Core 无法读取模型（${bytes.length} 字节，${header || "无文件头"}）`);
    }
    this.model = runtime.Model.fromMoc(this.moc);
    if (!this.model) throw new Error("无法创建 Live2D 模型");
    initializePose(this.model, this.poseGroups);
    this.model.update();
    this.parameterIndex = new Map();
    for (let index = 0; index < this.model.parameters.count; index += 1) {
      this.parameterIndex.set(this.model.parameters.ids[index], index);
    }
    this.textures = [];
    const loaded = await Promise.all(this.textureSources.map(async (source) => {
      const texture = await loadTexture(this.canvas, gl, source);
      if (this.destroyed) gl.deleteTexture(texture);
      else this.textures.push(texture);
      return texture;
    }));
    if (this.destroyed) return this;
    this.textures = loaded;
    gl.useProgram(this.program);
    gl.uniform1i(this.locations.texture, 0);
    gl.enable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    this.resize(this.width, this.height);
    return this;
  }

  resize(width, height) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    if (!this.model) return;
    this.updateTransform();
  }

  updateTransform() {
    if (!this.model) return;
    this.transform = this.viewMode === "full"
      ? fullBodyTransform(this.model, this.width, this.height)
      : portraitTransform(this.model, this.width, this.height);
  }

  setViewMode(value) {
    this.viewMode = value === "full" ? "full" : "portrait";
    this.updateTransform();
  }

  setState(value) {
    this.state = value || "idle";
  }

  setSpeaking(value) {
    this.speaking = Boolean(value);
  }

  setFocus(x, y) {
    this.targetFocusX = Math.max(-1, Math.min(1, Number(x) || 0));
    this.targetFocusY = Math.max(-1, Math.min(1, Number(y) || 0));
  }

  releaseFocus() {
    this.targetFocusX = 0;
    this.targetFocusY = 0;
  }

  triggerGesture() {
    this.gestureStartedAt = Date.now();
  }

  setParameter(id, value, weight = 1) {
    const index = this.parameterIndex.get(id);
    if (index === undefined) return;
    const parameters = this.model.parameters;
    const next = parameters.values[index] * (1 - weight) + value * weight;
    parameters.values[index] = Math.max(parameters.minimumValues[index], Math.min(parameters.maximumValues[index], next));
  }

  updateParameters(now) {
    const time = (now - this.startedAt) / 1000;
    const busy = this.state === "thinking";
    const answering = this.state === "answering";
    this.focusX += (this.targetFocusX - this.focusX) * 0.11;
    this.focusY += (this.targetFocusY - this.focusY) * 0.11;
    const sway = Math.sin(time * (busy ? 1.8 : 0.72));
    const gestureAge = (Date.now() - this.gestureStartedAt) / 1000;
    const gesture = gestureAge >= 0 && gestureAge < 0.9 ? Math.sin(gestureAge / 0.9 * Math.PI * 2) : 0;
    const mouth = this.speaking ? 0.25 + Math.abs(Math.sin(time * 10.5)) * 0.65 : (answering ? 0.12 : 0);
    this.setParameter("ParamAngleX", this.focusX * 22 + sway * 3.2 + gesture * 4);
    this.setParameter("ParamAngleY", -this.focusY * 16 + Math.sin(time * 0.53) * 2 - gesture * 8);
    this.setParameter("ParamAngleZ", this.focusX * this.focusY * -12 + sway * 1.5);
    this.setParameter("ParamEyeBallX", this.focusX);
    this.setParameter("ParamEyeBallY", -this.focusY);
    this.setParameter("ParamBodyAngleX", sway * (busy ? 4 : 2.2));
    this.setParameter("ParamBreath", 0.5 + Math.sin(time * 1.75) * 0.45);
    this.setParameter("ParamEyeLOpen", blinkValue(time));
    this.setParameter("ParamEyeROpen", blinkValue(time + 0.015));
    this.setParameter("ParamMouthOpenY", mouth);
    this.setParameter("ParamMouthForm", answering || this.speaking ? 0.55 : 0.08);
    this.model.update();
  }

  bindGeometry(drawableIndex) {
    const gl = this.gl;
    const drawables = this.model.drawables;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, drawables.vertexPositions[drawableIndex], gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.locations.position);
    gl.vertexAttribPointer(this.locations.position, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, drawables.vertexUvs[drawableIndex], gl.STATIC_DRAW);
    gl.enableVertexAttribArray(this.locations.uv);
    gl.vertexAttribPointer(this.locations.uv, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, drawables.indices[drawableIndex], gl.STATIC_DRAW);
  }

  drawDrawable(drawableIndex, maskPass = false) {
    const gl = this.gl;
    const drawables = this.model.drawables;
    const texture = this.textures[drawables.textureIndices[drawableIndex]];
    if (!texture || !drawables.indexCounts[drawableIndex]) return;
    this.bindGeometry(drawableIndex);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1f(this.locations.opacity, drawables.opacities[drawableIndex]);
    gl.uniform1f(this.locations.maskPass, maskPass ? 1 : 0);
    gl.drawElements(gl.TRIANGLES, drawables.indexCounts[drawableIndex], gl.UNSIGNED_SHORT, 0);
  }

  prepareMask(drawableIndex) {
    const gl = this.gl;
    const drawables = this.model.drawables;
    gl.stencilMask(0xff);
    gl.clearStencil(0);
    gl.clear(gl.STENCIL_BUFFER_BIT);
    gl.enable(gl.STENCIL_TEST);
    gl.stencilFunc(gl.ALWAYS, 1, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
    gl.colorMask(false, false, false, false);
    gl.disable(gl.BLEND);
    const masks = drawables.masks[drawableIndex] || [];
    for (let index = 0; index < masks.length; index += 1) this.drawDrawable(masks[index], true);
    gl.colorMask(true, true, true, true);
    gl.enable(gl.BLEND);
    const inverted = runtime.Utils.hasIsInvertedMaskBit(drawables.constantFlags[drawableIndex]);
    gl.stencilMask(0x00);
    gl.stencilFunc(inverted ? gl.NOTEQUAL : gl.EQUAL, 1, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
  }

  draw(now = Date.now()) {
    if (this.destroyed || !this.model) return;
    const gl = this.gl;
    this.updateParameters(now);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.uniform4fv(this.locations.transform, this.transform);
    const drawables = this.model.drawables;
    const order = Array.from({ length: drawables.count }, (_, index) => index)
      .sort((left, right) => drawables.renderOrders[left] - drawables.renderOrders[right]);
    for (const index of order) {
      if (!runtime.Utils.hasIsVisibleBit(drawables.dynamicFlags[index]) || drawables.opacities[index] <= 0.001) continue;
      if (drawables.maskCounts[index] > 0) this.prepareMask(index);
      else gl.disable(gl.STENCIL_TEST);
      const [source, destination] = blendMode(gl, drawables.constantFlags[index]);
      gl.blendFunc(source, destination);
      this.drawDrawable(index);
    }
    gl.disable(gl.STENCIL_TEST);
    drawables.resetDynamicFlags();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    const gl = this.gl;
    (this.textures || []).forEach((texture) => gl.deleteTexture(texture));
    if (this.positionBuffer) gl.deleteBuffer(this.positionBuffer);
    if (this.uvBuffer) gl.deleteBuffer(this.uvBuffer);
    if (this.indexBuffer) gl.deleteBuffer(this.indexBuffer);
    if (this.program) gl.deleteProgram(this.program);
    if (this.model) this.model.release();
    if (this.moc && this.moc._release) this.moc._release();
    this.model = null;
    this.moc = null;
  }
}

module.exports = {
  Live2DRenderer,
  loadTexture,
  blinkValue,
  initializePose,
  fullBodyTransform,
  portraitTransform,
  waitForRuntime,
};
