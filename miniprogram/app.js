App({
  onLaunch() {
    if (wx.cloud) {
      wx.cloud.init({
        env: "cloudbase-d2gg15kzjf02a74ab",
        traceUser: true,
      });
    }
  },
});
