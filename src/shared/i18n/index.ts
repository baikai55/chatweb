import i18n from "i18next";
import { initReactI18next } from "react-i18next";

/**
 * 中文优先。英文作为 fallback 的补充而非主语言。
 *
 * 这里只放应用外壳、设置页和通用文案。创作台四个面板的文案在移植面板时一起补进来
 * （grok2api 的 creativeConsole 命名空间约 240 行）。
 */

const STORAGE_KEY = "chatweb:language";

const zhCN = {
  common: {
    loading: "加载中",
    cancel: "取消",
    confirm: "确定",
    save: "保存",
    delete: "删除",
    edit: "编辑",
    retry: "重试",
    close: "关闭",
    copy: "复制",
    copied: "已复制",
    add: "添加",
    back: "返回",
  },
  app: {
    title: "网页聊天",
    settings: "设置",
    theme: { light: "浅色", dark: "深色", system: "跟随系统" },
    language: "语言",
  },
  onboarding: {
    title: "先连一个后端",
    description: "填入你自建的 API 地址和密钥。支持任何 OpenAI 兼容的后端。",
    usePreset: "使用预置后端",
    presetHint: "由部署方提供，你不需要自己的密钥",
    passwordLabel: "访问口令",
    addManually: "手动添加后端",
  },
  backend: {
    name: "名称",
    namePlaceholder: "例如：CPA 聚合",
    baseURL: "API 地址",
    baseURLPlaceholder: "https://your-host.com/v1",
    baseURLHint: "只填域名也可以，会自动补上 /v1",
    apiKey: "API Key",
    apiKeyPlaceholder: "sk-...",
    mode: { label: "密钥方式", direct: "浏览器直连", proxy: "服务端持有" },
    capabilities: "支持的能力",
    capabilityNames: { chat: "聊天", image: "绘图", video: "视频", tts: "语音合成", stt: "语音识别" },
    flavor: "后端类型",
    models: "模型",
    modelCount: "{{count}} 个模型",
    refreshModels: "刷新模型列表",
    noModels: "没有拉到模型。检查密钥是否有效。",
    deleteConfirm: "删除后端「{{name}}」？",
    deleteConfirmBody: "只删除本地保存的配置，不会影响后端本身。",
    directKeyWarning: "这个后端的密钥存在浏览器里。不要把本页链接分享给别人——对方可以直接取出密钥。",
    exportConfig: "导出配置",
    importConfig: "导入配置",
    exportWithKeys: "包含密钥",
    empty: "还没有配置任何后端",
  },
  errors: {
    networkFailed: "网络请求失败。检查地址是否可达，以及后端是否允许跨域访问。",
    noBackend: "还没有配置后端",
    noModelSelected: "没有可用的模型",
  },
} as const;

const en = {
  common: {
    loading: "Loading",
    cancel: "Cancel",
    confirm: "Confirm",
    save: "Save",
    delete: "Delete",
    edit: "Edit",
    retry: "Retry",
    close: "Close",
    copy: "Copy",
    copied: "Copied",
    add: "Add",
    back: "Back",
  },
  app: {
    title: "Chat Web",
    settings: "Settings",
    theme: { light: "Light", dark: "Dark", system: "System" },
    language: "Language",
  },
  onboarding: {
    title: "Connect a backend",
    description: "Enter your self-hosted API endpoint and key. Any OpenAI-compatible backend works.",
    usePreset: "Use preset backend",
    presetHint: "Provided by the deployer; no key of your own needed",
    passwordLabel: "Access password",
    addManually: "Add backend manually",
  },
  backend: {
    name: "Name",
    namePlaceholder: "e.g. CPA Gateway",
    baseURL: "API endpoint",
    baseURLPlaceholder: "https://your-host.com/v1",
    baseURLHint: "A bare domain works too; /v1 is appended automatically",
    apiKey: "API key",
    apiKeyPlaceholder: "sk-...",
    mode: { label: "Key handling", direct: "Browser direct", proxy: "Server-held" },
    capabilities: "Capabilities",
    capabilityNames: { chat: "Chat", image: "Image", video: "Video", tts: "Speech", stt: "Transcribe" },
    flavor: "Backend type",
    models: "Models",
    modelCount: "{{count}} models",
    refreshModels: "Refresh models",
    noModels: "No models returned. Check that the key is valid.",
    deleteConfirm: "Delete backend \"{{name}}\"?",
    deleteConfirmBody: "This only removes the locally saved config; the backend itself is untouched.",
    directKeyWarning: "This backend's key is stored in your browser. Do not share this page's link — anyone with it can extract the key.",
    exportConfig: "Export config",
    importConfig: "Import config",
    exportWithKeys: "Include keys",
    empty: "No backends configured yet",
  },
  errors: {
    networkFailed: "Request failed. Check that the endpoint is reachable and allows cross-origin requests.",
    noBackend: "No backend configured",
    noModelSelected: "No usable model",
  },
} as const;

function readStoredLanguage(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "zh-CN";
  } catch {
    return "zh-CN";
  }
}

void i18n.use(initReactI18next).init({
  resources: {
    "zh-CN": { translation: zhCN },
    en: { translation: en },
  },
  lng: readStoredLanguage(),
  fallbackLng: "zh-CN",
  interpolation: { escapeValue: false },
});

syncDocumentLanguage(i18n.language);
i18n.on("languageChanged", (language) => {
  try {
    localStorage.setItem(STORAGE_KEY, language);
  } catch {
    // 隐私模式下写不了，忽略
  }
  syncDocumentLanguage(language);
});

function syncDocumentLanguage(language: string): void {
  if (typeof document !== "undefined") document.documentElement.lang = language;
}

export default i18n;
