const avatars = require("../../../utils/avatars");

const families = ["全部", ...Array.from(new Set(avatars.catalog.map((item) => item.family)))];

Page({
  data: {
    families,
    familyIndex: 0,
    searchValue: "",
    visibleAvatars: [],
    focusedId: "hiyori",
    focused: null,
    selectedId: "hiyori",
    cloudReady: avatars.cloudReady,
    busyId: "",
    progress: 0,
    status: "",
  },

  onLoad() {
    this.refresh();
  },

  onShow() {
    this.refresh();
  },

  onUnload() {
    this._unloaded = true;
    if (this._download) this._download.abort();
  },

  present(item) {
    const size = item.builtIn ? 0 : [item.model, ...item.textures].reduce((sum, file) => sum + file.size, 0);
    return {
      id: item.id,
      name: item.name,
      initial: item.name.slice(0, 1),
      family: item.family,
      builtIn: Boolean(item.builtIn),
      installed: avatars.isInstalled(item),
      preview: item.localPreview,
      sizeText: item.builtIn ? "随小程序安装" : `${(size / 1048576).toFixed(1)} MB`,
    };
  },

  refresh() {
    const search = this.data.searchValue.trim().toLowerCase();
    const family = families[this.data.familyIndex];
    const visibleAvatars = avatars.catalog.filter((item) =>
      (!search || `${item.name} ${item.family}`.toLowerCase().includes(search)) &&
      (family === "全部" || item.family === family)
    ).map((item) => this.present(item));
    const focused = this.present(avatars.getAvatar(this.data.focusedId) || avatars.catalog[0]);
    this.setData({ visibleAvatars, focused, selectedId: avatars.getSelectedId() });
  },

  onSearch(event) {
    this.setData({ searchValue: event.detail.value }, () => this.refresh());
  },

  onFamilyChange(event) {
    this.setData({ familyIndex: Number(event.detail.value) }, () => this.refresh());
  },

  focusAvatar(event) {
    this.setData({ focusedId: event.currentTarget.dataset.id }, () => this.refresh());
  },

  previewAvatar() {
    const url = this.data.focused && this.data.focused.preview;
    if (url) wx.previewImage({ current: url, urls: [url] });
  },

  async useAvatar() {
    const id = this.data.focusedId;
    if (this.data.busyId) return;
    if (id !== "hiyori" && !await avatars.getInstalledModel(id)) {
      this.setData({ status: "本地模型不完整，请重新下载" });
      return;
    }
    avatars.setSelectedId(id);
    this.setData({ status: "已切换人物形象" });
    this.refresh();
  },

  async downloadAvatar() {
    const id = this.data.focusedId;
    if (this.data.busyId || !avatars.cloudReady) return;
    this.setData({ busyId: id, progress: 0, status: "正在下载模型素材" });
    try {
      this._download = avatars.downloadAvatar(id, (progress) => {
        if (!this._unloaded) this.setData({ progress });
      });
      await this._download.promise;
      if (this._unloaded) return;
      this.setData({ status: "下载完成，可以使用" });
      this.refresh();
    } catch (error) {
      if (!this._unloaded) this.setData({ status: error.message || "下载失败，请重试" });
    } finally {
      this._download = null;
      if (!this._unloaded) this.setData({ busyId: "" });
    }
  },

  removeAvatar() {
    const id = this.data.focusedId;
    if (this.data.busyId || id === this.data.selectedId) return;
    wx.showModal({
      title: "删除已下载人物",
      content: "删除后可随时从云存储重新下载。",
      success: async ({ confirm }) => {
        if (!confirm || this._unloaded) return;
        await avatars.removeAvatar(id);
        if (!this._unloaded) { this.setData({ status: "已删除本地模型" }); this.refresh(); }
      },
    });
  },
});
