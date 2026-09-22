const { normalizeBaseUrl } = require("./openai");

const SETTINGS_KEY = "openaiq.settings.v1";
const LEGACY_CONVERSATION_KEY = "openaiq.conversation.v1";
const PROFILES_KEY = "openaiq.profiles.v2";
const ACTIVE_PROFILE_KEY = "openaiq.activeProfile.v2";
const CONVERSATIONS_KEY = "openaiq.conversations.v2";
const ACTIVE_CONVERSATION_KEY = "openaiq.activeConversation.v2";
const USAGE_KEY = "openaiq.usage.v2";
const DEFAULT_SYSTEM_PROMPT = "你是一个简洁、可靠的中文助手。";

function storageGet(key, fallback) {
  try {
    const value = wx.getStorageSync(key);
    return value === "" || value === undefined || value === null ? fallback : value;
  } catch (_) {
    return fallback;
  }
}

function storageSet(key, value) {
  wx.setStorageSync(key, value);
  return value;
}

function newId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function normalizeSettings(saved = {}) {
  return {
    baseUrl: String(saved.baseUrl || "").trim(),
    apiKey: String(saved.apiKey || "").trim(),
    useSeparateServices: saved.useSeparateServices === true,
    imageBaseUrl: String(saved.imageBaseUrl || "").trim(),
    imageApiKey: String(saved.imageApiKey || "").trim(),
    chatModel: String(saved.chatModel || "").trim(),
    imageModel: String(saved.imageModel || "").trim(),
    systemPrompt: typeof saved.systemPrompt === "string" ? saved.systemPrompt : DEFAULT_SYSTEM_PROMPT,
    useCloudProxy: saved.useCloudProxy !== false,
    models: Array.isArray(saved.models) ? saved.models.filter((item) => typeof item === "string").slice(0, 500) : [],
    imageServiceModels: Array.isArray(saved.imageServiceModels)
      ? saved.imageServiceModels.filter((item) => typeof item === "string").slice(0, 500)
      : [],
    imageSize: String(saved.imageSize || "1024x1024"),
    imageQuality: String(saved.imageQuality || "standard"),
    imageStyle: String(saved.imageStyle || "vivid"),
    inputPrice: Math.max(0, Number(saved.inputPrice) || 0),
    outputPrice: Math.max(0, Number(saved.outputPrice) || 0),
    imagePrice: Math.max(0, Number(saved.imagePrice) || 0),
    autoSpeak: saved.autoSpeak === true,
    avatarEnabled: saved.avatarEnabled !== false,
    ttsVoice: String(saved.ttsVoice || "zh-CN-XiaoxiaoNeural"),
    ttsStyle: String(saved.ttsStyle || "general"),
    ttsRate: Math.max(-100, Math.min(200, Number(saved.ttsRate) || 0)),
    ttsVolume: Math.max(-100, Math.min(100, Number(saved.ttsVolume) || 0)),
    ttsPitch: Math.max(-100, Math.min(100, Number(saved.ttsPitch) || 0)),
    ttsVoices: Array.isArray(saved.ttsVoices) ? saved.ttsVoices.slice(0, 500) : [],
  };
}

function getProfiles() {
  const saved = storageGet(PROFILES_KEY, []);
  if (Array.isArray(saved) && saved.length) {
    return saved
      .filter((item) => item && item.id)
      .map((item) => ({
        id: String(item.id),
        name: String(item.name || "模型服务").slice(0, 30),
        ...normalizeSettings(item),
      }));
  }
  const legacy = normalizeSettings(storageGet(SETTINGS_KEY, {}));
  const profile = { id: "default", name: "默认服务", ...legacy };
  try {
    storageSet(PROFILES_KEY, [profile]);
    storageSet(ACTIVE_PROFILE_KEY, profile.id);
  } catch (_) {}
  return [profile];
}

function getActiveProfileId() {
  const profiles = getProfiles();
  const selected = String(storageGet(ACTIVE_PROFILE_KEY, ""));
  return profiles.some((item) => item.id === selected) ? selected : profiles[0].id;
}

function getSettings() {
  const profiles = getProfiles();
  const profileId = getActiveProfileId();
  const profile = profiles.find((item) => item.id === profileId) || profiles[0];
  return { ...normalizeSettings(profile), profileId: profile.id, profileName: profile.name };
}

function saveSettings(settings) {
  const profiles = getProfiles();
  const profileId = String(settings.profileId || getActiveProfileId());
  const index = profiles.findIndex((item) => item.id === profileId);
  const current = index >= 0 ? profiles[index] : { id: profileId, name: settings.profileName || "模型服务" };
  const value = {
    id: profileId,
    name: String(settings.profileName || current.name || "模型服务").trim().slice(0, 30) || "模型服务",
    ...normalizeSettings({
      ...settings,
      baseUrl: normalizeBaseUrl(settings.baseUrl),
      imageBaseUrl: normalizeBaseUrl(settings.imageBaseUrl),
      systemPrompt: String(settings.systemPrompt || "").trim(),
    }),
  };
  if (index >= 0) profiles[index] = value;
  else profiles.push(value);
  storageSet(PROFILES_KEY, profiles.slice(0, 20));
  storageSet(ACTIVE_PROFILE_KEY, profileId);
  storageSet(SETTINGS_KEY, value);
  return value;
}

function createProfile(name) {
  const profiles = getProfiles();
  const id = newId("profile");
  const profile = {
    id,
    name: String(name || `模型服务 ${profiles.length + 1}`).trim().slice(0, 30),
    ...normalizeSettings({}),
  };
  storageSet(PROFILES_KEY, profiles.concat(profile).slice(-20));
  storageSet(ACTIVE_PROFILE_KEY, id);
  return profile;
}

function selectProfile(id) {
  const profiles = getProfiles();
  const selected = profiles.find((item) => item.id === String(id));
  if (!selected) return null;
  storageSet(ACTIVE_PROFILE_KEY, selected.id);
  return selected;
}

function renameProfile(id, name) {
  const profiles = getProfiles();
  const index = profiles.findIndex((item) => item.id === String(id));
  const cleanName = String(name || "").trim().slice(0, 30);
  if (index < 0 || !cleanName) return null;
  profiles[index] = { ...profiles[index], name: cleanName };
  storageSet(PROFILES_KEY, profiles);
  return profiles[index];
}

function deleteProfile(id) {
  const profiles = getProfiles();
  if (profiles.length <= 1) return false;
  const remaining = profiles.filter((item) => item.id !== String(id));
  if (remaining.length === profiles.length) return false;
  storageSet(PROFILES_KEY, remaining);
  storageSet(ACTIVE_PROFILE_KEY, remaining[0].id);
  return true;
}

function isChatConfigured(settings) {
  return Boolean(settings.baseUrl && settings.apiKey && settings.chatModel);
}

function getImageService(settings) {
  const separate = settings && settings.useSeparateServices === true;
  return {
    baseUrl: separate ? settings.imageBaseUrl : settings.baseUrl,
    apiKey: separate ? settings.imageApiKey : settings.apiKey,
  };
}

function isImageConfigured(settings) {
  const service = getImageService(settings || {});
  return Boolean(service.baseUrl && service.apiKey && settings.imageModel);
}

function normalizeMessages(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && item.id && (item.role === "user" || item.role === "assistant"))
    .slice(-80)
    .map((item) => {
      const normalized = item.pending
        ? { ...item, pending: false, error: true, content: item.content || "上次请求已中断。" }
        : { ...item };
      if (normalized.attachment && normalized.attachment.dataUrl) {
        const { dataUrl, ...attachment } = normalized.attachment;
        normalized.attachment = attachment;
      }
      return normalized;
    });
}

function autoTitle(messages) {
  const first = (messages || []).find((item) => item.role === "user" && item.content);
  return first ? String(first.content).replace(/\s+/g, " ").trim().slice(0, 24) : "新对话";
}

function getConversations() {
  let saved = storageGet(CONVERSATIONS_KEY, null);
  if (!Array.isArray(saved)) {
    const legacy = normalizeMessages(storageGet(LEGACY_CONVERSATION_KEY, []));
    if (legacy.length) {
      const now = Date.now();
      saved = [{ id: newId("chat"), title: autoTitle(legacy), createdAt: now, updatedAt: now, messages: legacy }];
      try {
        storageSet(CONVERSATIONS_KEY, saved);
        storageSet(ACTIVE_CONVERSATION_KEY, saved[0].id);
      } catch (_) {}
    } else {
      saved = [];
      try { storageSet(CONVERSATIONS_KEY, saved); } catch (_) {}
    }
  }
  return saved
    .filter((item) => item && item.id)
    .map((item) => ({
      id: String(item.id),
      title: String(item.title || "新对话").slice(0, 40),
      createdAt: Number(item.createdAt) || Date.now(),
      updatedAt: Number(item.updatedAt) || Number(item.createdAt) || Date.now(),
      messages: normalizeMessages(item.messages),
    }));
}

function getActiveConversationId() {
  const conversations = getConversations();
  const selected = String(storageGet(ACTIVE_CONVERSATION_KEY, ""));
  return conversations.some((item) => item.id === selected) ? selected : (conversations[0] && conversations[0].id) || "";
}

function getConversation() {
  const conversations = getConversations();
  const active = conversations.find((item) => item.id === getActiveConversationId());
  return active ? active.messages : [];
}

function getConversationList() {
  return getConversations()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((item) => ({
      id: item.id,
      title: item.title,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      messageCount: item.messages.length,
      preview: String((item.messages[item.messages.length - 1] || {}).content || "暂无消息").replace(/\s+/g, " ").slice(0, 60),
    }));
}

function createConversation(title = "新对话") {
  const conversations = getConversations();
  const now = Date.now();
  const conversation = {
    id: newId("chat"),
    title: String(title || "新对话").trim().slice(0, 40) || "新对话",
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  storageSet(CONVERSATIONS_KEY, conversations.concat(conversation).slice(-50));
  storageSet(ACTIVE_CONVERSATION_KEY, conversation.id);
  return conversation;
}

function selectConversation(id) {
  const selected = getConversations().find((item) => item.id === String(id));
  if (!selected) return null;
  storageSet(ACTIVE_CONVERSATION_KEY, selected.id);
  return selected;
}

function saveConversation(messages) {
  try {
    let conversations = getConversations();
    let activeId = getActiveConversationId();
    let index = conversations.findIndex((item) => item.id === activeId);
    if (index < 0) {
      const created = createConversation();
      conversations = getConversations();
      activeId = created.id;
      index = conversations.findIndex((item) => item.id === activeId);
    }
    const normalized = normalizeMessages(messages);
    const current = conversations[index];
    conversations[index] = {
      ...current,
      title: current.title === "新对话" ? autoTitle(normalized) : current.title,
      updatedAt: Date.now(),
      messages: normalized,
    };
    storageSet(CONVERSATIONS_KEY, conversations.slice(-50));
    storageSet(ACTIVE_CONVERSATION_KEY, activeId);
    storageSet(LEGACY_CONVERSATION_KEY, normalized);
  } catch (_) {
    // Storage pressure must not break the active conversation UI.
  }
}

function clearConversation() {
  saveConversation([]);
}

function renameConversation(id, title) {
  const conversations = getConversations();
  const index = conversations.findIndex((item) => item.id === String(id));
  const cleanTitle = String(title || "").trim().slice(0, 40);
  if (index < 0 || !cleanTitle) return false;
  conversations[index] = { ...conversations[index], title: cleanTitle, updatedAt: Date.now() };
  storageSet(CONVERSATIONS_KEY, conversations);
  return true;
}

function deleteConversation(id) {
  const conversations = getConversations();
  const remaining = conversations.filter((item) => item.id !== String(id));
  if (remaining.length === conversations.length) return false;
  storageSet(CONVERSATIONS_KEY, remaining);
  const next = remaining.sort((a, b) => b.updatedAt - a.updatedAt)[0];
  storageSet(ACTIVE_CONVERSATION_KEY, next ? next.id : "");
  return true;
}

function getUsageStats() {
  const saved = storageGet(USAGE_KEY, {});
  return {
    requests: Math.max(0, Number(saved.requests) || 0),
    promptTokens: Math.max(0, Number(saved.promptTokens) || 0),
    completionTokens: Math.max(0, Number(saved.completionTokens) || 0),
    totalTokens: Math.max(0, Number(saved.totalTokens) || 0),
    imageCount: Math.max(0, Number(saved.imageCount) || 0),
    estimatedCost: Math.max(0, Number(saved.estimatedCost) || 0),
  };
}

function recordUsage(entry = {}) {
  const current = getUsageStats();
  return storageSet(USAGE_KEY, {
    requests: current.requests + (Number(entry.requests) || 1),
    promptTokens: current.promptTokens + Math.max(0, Number(entry.promptTokens) || 0),
    completionTokens: current.completionTokens + Math.max(0, Number(entry.completionTokens) || 0),
    totalTokens: current.totalTokens + Math.max(0, Number(entry.totalTokens) || 0),
    imageCount: current.imageCount + Math.max(0, Number(entry.imageCount) || 0),
    estimatedCost: current.estimatedCost + Math.max(0, Number(entry.estimatedCost) || 0),
  });
}

function resetUsageStats() {
  return storageSet(USAGE_KEY, {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    imageCount: 0,
    estimatedCost: 0,
  });
}

module.exports = {
  DEFAULT_SYSTEM_PROMPT,
  clearConversation,
  createConversation,
  createProfile,
  deleteConversation,
  deleteProfile,
  getActiveConversationId,
  getConversation,
  getConversationList,
  getImageService,
  getProfiles,
  getSettings,
  getUsageStats,
  isChatConfigured,
  isImageConfigured,
  recordUsage,
  renameConversation,
  renameProfile,
  resetUsageStats,
  saveConversation,
  saveSettings,
  selectConversation,
  selectProfile,
};
