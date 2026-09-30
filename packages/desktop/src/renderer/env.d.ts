interface Window {
  osecDesktop?: import("@0/shared").DesktopHostBridge;
}

declare module "*.svg" {
  const url: string;
  export default url;
}
declare module "*.css";
