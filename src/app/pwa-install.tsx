import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const installListeners = new Set<() => void>();

// 事件可能在引导页显示期间触发，此时侧栏还没有挂载，不能只在按钮组件里监听。
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    installListeners.forEach((listener) => listener());
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    installListeners.forEach((listener) => listener());
  });
}

function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches
    || ("standalone" in navigator && Boolean((navigator as Navigator & { standalone?: boolean }).standalone));
}

export function InstallAppButton() {
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(deferredPrompt);
  const [iosInstall, setIosInstall] = useState(false);

  useEffect(() => {
    if (isStandalone()) return;

    setIosInstall(isIos());
    const onInstallStateChange = () => {
      setPromptEvent(deferredPrompt);
      if (!deferredPrompt) setIosInstall(false);
    };
    installListeners.add(onInstallStateChange);
    return () => {
      installListeners.delete(onInstallStateChange);
    };
  }, []);

  if (!promptEvent && !iosInstall) return null;

  async function install(): Promise<void> {
    if (!promptEvent) {
      toast.info("请打开浏览器分享菜单，选择“添加到主屏幕”");
      return;
    }

    const activePrompt = promptEvent;
    // beforeinstallprompt 只能消费一次；同步清掉模块缓存，避免其他挂载实例或重新挂载再次显示旧按钮。
    if (deferredPrompt === activePrompt) deferredPrompt = null;
    installListeners.forEach((listener) => listener());
    try {
      await activePrompt.prompt();
      await activePrompt.userChoice;
    } catch {
      // 浏览器可能只允许同一个安装事件调用一次。
    } finally {
      setPromptEvent(null);
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-8 shrink-0"
      aria-label="安装到手机"
      title="安装到手机"
      onClick={() => { void install(); }}
    >
      <Download className="size-3.5" />
    </Button>
  );
}
