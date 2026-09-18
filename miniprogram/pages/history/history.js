const {
  createConversation,
  deleteConversation,
  getActiveConversationId,
  getConversationList,
  renameConversation,
  selectConversation,
} = require("../../utils/storage");

function formatTime(value) {
  const date = new Date(Number(value) || Date.now());
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

Page({
  data: {
    query: "",
    conversations: [],
    filtered: [],
    activeId: "",
  },

  onShow() {
    this.loadConversations();
  },

  loadConversations() {
    const conversations = getConversationList().map((item) => ({ ...item, timeText: formatTime(item.updatedAt) }));
    this.setData({ conversations, activeId: getActiveConversationId() });
    this.applyFilter(this.data.query, conversations);
  },

  onSearch(event) {
    const query = event.detail.value;
    this.setData({ query });
    this.applyFilter(query, this.data.conversations);
  },

  applyFilter(query, conversations) {
    const keyword = String(query || "").trim().toLowerCase();
    const filtered = keyword
      ? conversations.filter((item) => `${item.title} ${item.preview}`.toLowerCase().includes(keyword))
      : conversations;
    this.setData({ filtered });
  },

  openConversation(event) {
    if (!selectConversation(event.currentTarget.dataset.id)) return;
    wx.navigateBack({ delta: 1 });
  },

  newConversation() {
    createConversation();
    wx.navigateBack({ delta: 1 });
  },

  renameConversation(event) {
    const id = event.currentTarget.dataset.id;
    const current = this.data.conversations.find((item) => item.id === id);
    if (!current) return;
    wx.showModal({
      title: "重命名会话",
      editable: true,
      content: current.title,
      placeholderText: "输入会话名称",
      success: (result) => {
        if (result.confirm && renameConversation(id, result.content)) this.loadConversations();
      },
    });
  },

  deleteConversation(event) {
    const id = event.currentTarget.dataset.id;
    wx.showModal({
      title: "删除会话",
      content: "该会话仅保存在本机，删除后无法恢复。",
      confirmText: "删除",
      confirmColor: "#c4473a",
      success: (result) => {
        if (result.confirm && deleteConversation(id)) this.loadConversations();
      },
    });
  },
});
