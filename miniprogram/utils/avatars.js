const catalog = require("./avatar-catalog");
const cloudPrefix = require("./avatar-cloud-config");

const SELECTED_KEY = "ning.avatar.selected.v1";
const INSTALLED_KEY = "ning.avatar.installed.v1";
const DEFAULT_ID = "hiyori";

function getAvatar(id) {
  return catalog.find((item) => item.id === id) || null;
}

function getSelectedId() {
  return getAvatar(wx.getStorageSync(SELECTED_KEY))?.id || DEFAULT_ID;
}

function getInstalledVersions() {
  return wx.getStorageSync(INSTALLED_KEY) || {};
}

function isInstalled(avatar) {
  return Boolean(avatar && (avatar.builtIn || getInstalledVersions()[avatar.id] === avatar.version));
}

function cloudFileID(file) {
  if (!cloudPrefix || !/^cloud:\/\//.test(cloudPrefix)) throw new Error("人物云存储尚未部署，请先上传模型素材");
  return `${cloudPrefix}${file.cloudPath}`;
}

function localPath(avatar, index) {
  const suffix = index === 0 ? "model.moc3" : `texture-${index - 1}.png`;
  return `${wx.env.USER_DATA_PATH}/ning-avatar-${avatar.id}-${avatar.version}-${suffix}`;
}

function modelFiles(avatar) {
  return [avatar.model, ...avatar.textures];
}

function fileInfo(filePath) {
  return new Promise((resolve, reject) => wx.getFileSystemManager().getFileInfo({
    filePath, digestAlgorithm: "sha1", success: resolve, fail: reject,
  }));
}

async function verified(filePath, expected) {
  try {
    const info = await fileInfo(filePath);
    return info.size === expected.size && String(info.digest).toLowerCase() === expected.sha1;
  } catch (_) {
    return false;
  }
}

async function getInstalledModel(id = getSelectedId()) {
  const avatar = getAvatar(id);
  if (!avatar || avatar.builtIn || !isInstalled(avatar)) return null;
  const files = modelFiles(avatar);
  for (let index = 0; index < files.length; index += 1) {
    if (!await verified(localPath(avatar, index), files[index])) return null;
  }
  return {
    id: avatar.id,
    modelPath: localPath(avatar, 0),
    texturePaths: avatar.textures.map((_, index) => localPath(avatar, index + 1)),
  };
}

async function getActiveModel() {
  const selected = getSelectedId();
  if (selected === DEFAULT_ID) return null;
  const model = await getInstalledModel(selected);
  if (model) return model;
  wx.setStorageSync(SELECTED_KEY, DEFAULT_ID);
  return null;
}

function setSelectedId(id) {
  const avatar = getAvatar(id);
  if (!avatar || !isInstalled(avatar)) throw new Error("请先下载并验证人物模型");
  wx.setStorageSync(SELECTED_KEY, id);
}

function removeFile(filePath) {
  return new Promise((resolve) => wx.getFileSystemManager().unlink({
    filePath, success: resolve, fail: resolve,
  }));
}

async function removeAvatar(id) {
  const avatar = getAvatar(id);
  if (!avatar || avatar.builtIn || id === getSelectedId()) return;
  await Promise.all(modelFiles(avatar).map((_, index) => removeFile(localPath(avatar, index))));
  const installed = getInstalledVersions();
  delete installed[id];
  wx.setStorageSync(INSTALLED_KEY, installed);
}

function downloadAvatar(id, onProgress = () => {}) {
  const avatar = getAvatar(id);
  if (!avatar || avatar.builtIn) throw new Error("此人物无需下载");
  const files = modelFiles(avatar);
  let canceled = false;
  let activeTask = null;
  let cancelPending = null;
  const abort = () => {
    canceled = true;
    if (activeTask && activeTask.abort) activeTask.abort();
    if (cancelPending) cancelPending(new Error("下载已取消"));
  };

  const promise = (async () => {
    if (await getInstalledModel(id)) return;
    const paths = files.map((_, index) => localPath(avatar, index));
    const total = files.reduce((size, file) => size + file.size, 0);
    let completed = 0;
    try {
      for (let index = 0; index < files.length; index += 1) {
        if (canceled) throw new Error("下载已取消");
        await removeFile(paths[index]);
        const downloaded = await new Promise((resolve, reject) => {
          let settled = false;
          const settle = (done, value) => {
            if (settled) return;
            settled = true;
            cancelPending = null;
            activeTask = null;
            done(value);
          };
          cancelPending = (error) => settle(reject, error);
          activeTask = wx.cloud.downloadFile({
            fileID: cloudFileID(files[index]),
            success: (result) => settle(resolve, result.tempFilePath),
            fail: (error) => settle(reject, new Error(error.errMsg || "人物素材下载失败")),
          });
          if (activeTask && activeTask.onProgressUpdate) activeTask.onProgressUpdate((state) => {
            onProgress(Math.min(99, Math.round((completed + files[index].size * state.progress / 100) / total * 100)));
          });
        });
        if (canceled) throw new Error("下载已取消");
        if (!await verified(downloaded, files[index])) throw new Error("人物素材校验失败，请重新下载");
        await new Promise((resolve, reject) => wx.getFileSystemManager().saveFile({
          tempFilePath: downloaded, filePath: paths[index], success: resolve, fail: reject,
        }));
        completed += files[index].size;
        onProgress(Math.round(completed / total * 100));
      }
      if (canceled) throw new Error("下载已取消");
      const installed = getInstalledVersions();
      installed[id] = avatar.version;
      wx.setStorageSync(INSTALLED_KEY, installed);
    } catch (error) {
      await Promise.all(paths.map(removeFile));
      throw error;
    }
  })();
  return { promise, abort };
}

module.exports = {
  catalog, cloudReady: Boolean(cloudPrefix), getAvatar, getSelectedId, getInstalledVersions,
  isInstalled, getInstalledModel, getActiveModel, setSelectedId, downloadAvatar,
  removeAvatar,
};
