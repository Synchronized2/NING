const {
  classifyModels,
  isSecureBaseUrl,
  listModels,
  listTtsVoices,
  normalizeBaseUrl,
  synthesizeSpeech,
} = require("../../utils/openai");
const {
  createProfile,
  deleteProfile,
  getProfiles,
  getSettings,
  getUsageStats,
  renameProfile,
  resetUsageStats,
  saveSettings,
  selectProfile: activateProfile,
} = require("../../utils/storage");

const FALLBACK_TTS_VOICES = [
  { shortName: "zh-CN-XiaoxiaoNeural", localName: "晓晓", locale: "zh-CN", gender: "Female" },
  { shortName: "zh-CN-XiaoyiNeural", localName: "晓伊", locale: "zh-CN", gender: "Female" },
  { shortName: "zh-CN-YunjianNeural", localName: "云健", locale: "zh-CN", gender: "Male" },
  { shortName: "zh-CN-YunxiNeural", localName: "云希", locale: "zh-CN", gender: "Male" },
  { shortName: "zh-CN-YunxiaNeural", localName: "云夏", locale: "zh-CN", gender: "Male" },
  { shortName: "zh-CN-YunyangNeural", localName: "云扬", locale: "zh-CN", gender: "Male" },
  { shortName: "zh-CN-liaoning-XiaobeiNeural", localName: "晓北（辽宁）", locale: "zh-CN-liaoning", gender: "Female" },
  { shortName: "zh-CN-shaanxi-XiaoniNeural", localName: "晓妮（陕西）", locale: "zh-CN-shaanxi", gender: "Female" },
  { shortName: "zh-HK-HiuGaaiNeural", localName: "曉佳（粤语）", locale: "zh-HK", gender: "Female" },
  { shortName: "zh-HK-HiuMaanNeural", localName: "曉曼（粤语）", locale: "zh-HK", gender: "Female" },
  { shortName: "zh-HK-WanLungNeural", localName: "云龙（粤语）", locale: "zh-HK", gender: "Male" },
  { shortName: "zh-TW-HsiaoChenNeural", localName: "曉臻（台湾）", locale: "zh-TW", gender: "Female" },
  { shortName: "zh-TW-HsiaoYuNeural", localName: "曉雨（台湾）", locale: "zh-TW", gender: "Female" },
  { shortName: "zh-TW-YunJheNeural", localName: "云哲（台湾）", locale: "zh-TW", gender: "Male" },
];

function voiceLabel(voice) {
  const gender = voice.gender === "Male" ? "男" : voice.gender === "Female" ? "女" : voice.gender;
  return `${voice.localName || voice.shortName} · ${voice.locale}${gender ? ` · ${gender}` : ""}`;
}

function usageDisplay() {
  const usage = getUsageStats();
  return {
    ...usage,
    estimatedCostText: `$${usage.estimatedCost.toFixed(4)}`,
  };
}

const TTS_PREVIEW_TEXT = "你好，欢迎使用 NING。这是当前音色的试听，愿你今天心情愉快。";

function previewError(error) {
  const message = String(error && (error.message || error.errMsg) || "");
  if (/FUNCTION_NOT_FOUND|FunctionName parameter could not be found|-501000/.test(message)) {
    return "朗读服务尚未就绪，请检查云环境中的中转云函数是否已部署。";
  }
  return message ? message.replace(/\s+/g, " ").slice(0, 160) : "试听失败，请稍后重试。";
}

Page({
  data: {
    profileId: "",
    profileName: "",
    profiles: [],
    profileNames: [],
    profileIndex: 0,
    baseUrl: "",
    apiKey: "",
    chatModel: "",
    imageModel: "",
    systemPrompt: "",
    useCloudProxy: true,
    allModels: [],
    chatModels: [],
    imageModels: [],
    keyMasked: true,
    fetching: false,
    modelStatus: "",
    modelStatusError: false,
    inputPrice: "0",
    outputPrice: "0",
    imagePrice: "0",
    autoSpeak: false,
    ttsVoice: "zh-CN-XiaoxiaoNeural",
    ttsRate: 0,
    ttsVolume: 0,
    ttsPitch: 0,
    ttsVoices: FALLBACK_TTS_VOICES,
    ttsVoiceNames: FALLBACK_TTS_VOICES.map(voiceLabel),
    ttsVoiceIndex: 0,
    fetchingVoices: false,
    ttsPreviewState: "idle",
    ttsPreviewStatus: "",
    ttsPreviewError: false,
    usage: usageDisplay(),
  },

  onLoad() {
    this.loadSettings();
  },

  onShow() {
    this.setData({ usage: usageDisplay() });
  },

  onUnload() {
    this._unloaded = true;
    this.stopTtsPreview();
    if (this._modelRequest) this._modelRequest.abort();
    if (this._voiceRequest) this._voiceRequest.abort();
  },

  onHide() {
    this.stopTtsPreview();
  },

  loadSettings() {
    this.stopTtsPreview();
    const settings = getSettings();
    const profiles = getProfiles();
    const models = classifyModels(settings.models);
    const ttsVoices = settings.ttsVoices.length ? settings.ttsVoices : FALLBACK_TTS_VOICES;
    this.setData({
      profileId: settings.profileId,
      profileName: settings.profileName,
      profiles,
      profileNames: profiles.map((item) => item.name),
      profileIndex: Math.max(0, profiles.findIndex((item) => item.id === settings.profileId)),
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      chatModel: settings.chatModel,
      imageModel: settings.imageModel,
      systemPrompt: settings.systemPrompt,
      useCloudProxy: settings.useCloudProxy,
      allModels: models.all,
      chatModels: models.chat,
      imageModels: models.image,
      modelStatus: models.all.length ? `已缓存 ${models.all.length} 个模型` : "",
      modelStatusError: false,
      inputPrice: String(settings.inputPrice),
      outputPrice: String(settings.outputPrice),
      imagePrice: String(settings.imagePrice),
      autoSpeak: settings.autoSpeak,
      ttsVoice: settings.ttsVoice,
      ttsRate: settings.ttsRate,
      ttsVolume: settings.ttsVolume,
      ttsPitch: settings.ttsPitch,
      ttsVoices,
      ttsVoiceNames: ttsVoices.map(voiceLabel),
      ttsVoiceIndex: Math.max(0, ttsVoices.findIndex((item) => item.shortName === settings.ttsVoice)),
    });
  },

  onFieldInput(event) {
    this.setData({ [event.currentTarget.dataset.field]: event.detail.value });
  },

  onSliderChange(event) {
    if (["ttsRate", "ttsVolume", "ttsPitch"].includes(event.currentTarget.dataset.field)) this.stopTtsPreview();
    this.setData({ [event.currentTarget.dataset.field]: Number(event.detail.value) });
  },

  toggleKey(event) {
    this.setData({ keyMasked: !event.detail.value });
  },

  toggleCloudProxy(event) {
    this.setData({ useCloudProxy: event.detail.value });
  },

  toggleAutoSpeak(event) {
    this.setData({ autoSpeak: event.detail.value });
  },

  selectProfile(event) {
    const profile = this.data.profiles[Number(event.detail.value)];
    if (profile && activateProfile(profile.id)) this.loadSettings();
  },

  createProfile() {
    wx.showModal({
      title: "新建服务档案",
      editable: true,
      placeholderText: "例如：NING 服务",
      success: (result) => {
        if (!result.confirm) return;
        createProfile(String(result.content || "").trim());
        this.loadSettings();
      },
    });
  },

  renameProfile() {
    wx.showModal({
      title: "重命名服务档案",
      editable: true,
      content: this.data.profileName,
      success: (result) => {
        if (result.confirm && renameProfile(this.data.profileId, result.content)) this.loadSettings();
      },
    });
  },

  deleteProfile() {
    if (this.data.profiles.length <= 1) return wx.showToast({ title: "至少保留一个服务档案", icon: "none" });
    wx.showModal({
      title: "删除服务档案",
      content: `确定删除“${this.data.profileName}”吗？`,
      confirmText: "删除",
      confirmColor: "#c4473a",
      success: (result) => {
        if (result.confirm && deleteProfile(this.data.profileId)) this.loadSettings();
      },
    });
  },

  selectChatModel(event) {
    const value = this.data.chatModels[Number(event.detail.value)];
    if (value) this.setData({ chatModel: value });
  },

  selectImageModel(event) {
    const value = this.data.imageModels[Number(event.detail.value)];
    if (value) this.setData({ imageModel: value });
  },

  selectTtsVoice(event) {
    this.stopTtsPreview();
    const index = Number(event.detail.value);
    const voice = this.data.ttsVoices[index];
    if (voice) this.setData({ ttsVoiceIndex: index, ttsVoice: voice.shortName });
  },

  async previewTtsVoice() {
    if (this._unloaded) return;
    if (this._ttsPreviewSession) return this.stopTtsPreview();
    const session = {};
    this._ttsPreviewSession = session;
    this.setData({ ttsPreviewState: "preparing", ttsPreviewStatus: "正在生成试听音频…", ttsPreviewError: false });
    try {
      session.request = synthesizeSpeech({
        text: TTS_PREVIEW_TEXT,
        voice: this.data.ttsVoice,
        rate: this.data.ttsRate,
        volume: this.data.ttsVolume,
        pitch: this.data.ttsPitch,
      });
      const result = await session.request.promise;
      session.request = null;
      session.fileId = result.fileId;
      session.localPath = result.localPath;
      if (this._ttsPreviewSession !== session) return;
      if (!session.localPath && session.fileId) {
        const downloaded = await new Promise((resolve, reject) => {
          session.download = wx.cloud.downloadFile({
            fileID: session.fileId,
            success: resolve,
            fail: () => reject(new Error("试听音频下载失败，请稍后重试。")),
          });
        });
        session.download = null;
        session.localPath = downloaded.tempFilePath;
      }
      if (this._ttsPreviewSession !== session) return;
      if (!session.localPath) throw new Error("未收到试听音频，请重试。");
      const audio = wx.createInnerAudioContext();
      session.audio = audio;
      audio.obeyMuteSwitch = false;
      audio.onPlay(() => {
        if (this._ttsPreviewSession === session) this.setData({ ttsPreviewState: "playing", ttsPreviewStatus: "正在播放当前音色" });
      });
      audio.onEnded(() => {
        if (this._ttsPreviewSession !== session) return;
        this.stopTtsPreview();
        this.setData({ ttsPreviewStatus: "试听完成，Edge TTS 可正常使用。" });
      });
      audio.onError(() => {
        if (this._ttsPreviewSession !== session) return;
        this.stopTtsPreview();
        this.setData({ ttsPreviewError: true, ttsPreviewStatus: "音频播放失败，请稍后重试。" });
      });
      audio.src = session.localPath;
      audio.play();
    } catch (error) {
      if (this._ttsPreviewSession !== session) return;
      this.stopTtsPreview();
      if (!error.aborted) this.setData({ ttsPreviewError: true, ttsPreviewStatus: previewError(error) });
    } finally {
      // An aborted synthesis or download may still resolve with a temporary file.
      if (this._ttsPreviewSession !== session) this.releaseTtsPreview(session);
    }
  },

  releaseTtsPreview(session) {
    if (!session) return;
    for (const key of ["request", "download"]) {
      const operation = session[key];
      session[key] = null;
      if (operation && operation.abort) {
        try { operation.abort(); } catch (_) {}
      }
    }
    if (session.audio) {
      const audio = session.audio;
      session.audio = null;
      try { audio.stop(); } catch (_) {}
      try { audio.destroy(); } catch (_) {}
    }
    if (session.localPath && wx.getFileSystemManager) {
      const filePath = session.localPath;
      session.localPath = "";
      try { wx.getFileSystemManager().unlink({ filePath, fail() {} }); } catch (_) {}
    }
    if (session.fileId && wx.cloud && wx.cloud.deleteFile) {
      const fileId = session.fileId;
      session.fileId = "";
      try { wx.cloud.deleteFile({ fileList: [fileId], fail() {} }); } catch (_) {}
    }
  },

  stopTtsPreview() {
    const session = this._ttsPreviewSession;
    this._ttsPreviewSession = null;
    this.releaseTtsPreview(session);
    if (!this._unloaded) this.setData({ ttsPreviewState: "idle", ttsPreviewStatus: "", ttsPreviewError: false });
  },

  async fetchModels() {
    if (this.data.fetching) return;
    const baseUrl = normalizeBaseUrl(this.data.baseUrl);
    const apiKey = this.data.apiKey.trim();
    if (!isSecureBaseUrl(baseUrl)) return wx.showToast({ title: "请输入有效的 HTTPS URL", icon: "none" });
    if (!apiKey) return wx.showToast({ title: "请输入 API Key", icon: "none" });
    this.setData({ fetching: true, modelStatus: "正在读取 /models...", modelStatusError: false });
    const operation = listModels({ baseUrl, apiKey, useCloudProxy: this.data.useCloudProxy });
    this._modelRequest = operation;
    try {
      const models = await operation.promise;
      this.setData({
        baseUrl,
        allModels: models.all,
        chatModels: models.chat,
        imageModels: models.image,
        chatModel: this.data.chatModel || models.chat[0] || "",
        imageModel: this.data.imageModel || models.image[0] || "",
        modelStatus: `获取成功：${models.all.length} 个模型`,
        modelStatusError: false,
      });
    } catch (error) {
      if (!error.aborted) {
        this.setData({ modelStatus: error.message, modelStatusError: true });
        wx.showToast({ title: "获取模型失败", icon: "none" });
      }
    } finally {
      this._modelRequest = null;
      this.setData({ fetching: false });
    }
  },

  async fetchTtsVoices() {
    if (this.data.fetchingVoices) return;
    this.setData({ fetchingVoices: true });
    const operation = listTtsVoices();
    this._voiceRequest = operation;
    try {
      const voices = await operation.promise;
      const index = Math.max(0, voices.findIndex((item) => item.shortName === this.data.ttsVoice));
      if (voices[index] && voices[index].shortName !== this.data.ttsVoice) this.stopTtsPreview();
      this.setData({
        ttsVoices: voices,
        ttsVoiceNames: voices.map(voiceLabel),
        ttsVoiceIndex: index,
        ttsVoice: voices[index] ? voices[index].shortName : this.data.ttsVoice,
      });
      wx.showToast({ title: `已获取 ${voices.length} 个人声`, icon: "none" });
    } catch (error) {
      if (!error.aborted) wx.showToast({ title: error.message || "获取人声失败", icon: "none" });
    } finally {
      this._voiceRequest = null;
      this.setData({ fetchingVoices: false });
    }
  },

  resetUsage() {
    wx.showModal({
      title: "清除用量统计",
      content: "统计仅保存在本机，确定清除吗？",
      success: (result) => {
        if (!result.confirm) return;
        resetUsageStats();
        this.setData({ usage: usageDisplay() });
      },
    });
  },

  collectSettings() {
    return {
      profileId: this.data.profileId,
      profileName: this.data.profileName,
      baseUrl: normalizeBaseUrl(this.data.baseUrl),
      apiKey: this.data.apiKey.trim(),
      chatModel: this.data.chatModel.trim(),
      imageModel: this.data.imageModel.trim(),
      systemPrompt: this.data.systemPrompt,
      useCloudProxy: this.data.useCloudProxy,
      models: this.data.allModels,
      inputPrice: Number(this.data.inputPrice) || 0,
      outputPrice: Number(this.data.outputPrice) || 0,
      imagePrice: Number(this.data.imagePrice) || 0,
      autoSpeak: this.data.autoSpeak,
      ttsVoice: this.data.ttsVoice,
      ttsRate: this.data.ttsRate,
      ttsVolume: this.data.ttsVolume,
      ttsPitch: this.data.ttsPitch,
      ttsVoices: this.data.ttsVoices,
      imageSize: getSettings().imageSize,
      imageQuality: getSettings().imageQuality,
      imageStyle: getSettings().imageStyle,
    };
  },

  save() {
    const value = this.collectSettings();
    if (!isSecureBaseUrl(value.baseUrl)) return wx.showToast({ title: "请输入有效的 HTTPS URL", icon: "none" });
    if (!value.apiKey) return wx.showToast({ title: "请输入 API Key", icon: "none" });
    if (!value.chatModel) return wx.showToast({ title: "请选择或填写对话模型", icon: "none" });
    try {
      saveSettings(value);
      wx.showToast({ title: "设置已保存" });
      setTimeout(() => wx.navigateBack({ delta: 1 }), 350);
    } catch (_) {
      wx.showToast({ title: "设置保存失败", icon: "none" });
    }
  },
});
