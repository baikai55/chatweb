import { RefreshCw, TriangleAlert } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

import { Button } from "@/components/ui/button";

type AppErrorBoundaryProps = {
  children: ReactNode;
};

type AppErrorBoundaryState = {
  failed: boolean;
};

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("应用渲染失败", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;

    return (
      <main className="flex min-h-dvh items-center justify-center bg-background px-6 text-foreground">
        <div className="w-full max-w-md text-center" role="alert" aria-live="assertive">
          <TriangleAlert className="mx-auto size-8 text-destructive" aria-hidden="true" />
          <h1 className="mt-4 text-lg font-semibold">页面遇到错误</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            当前内容仍保存在浏览器中。重新加载后可以继续使用。
          </p>
          <Button className="mt-5" onClick={() => window.location.reload()}>
            <RefreshCw className="size-4" aria-hidden="true" />
            重新加载
          </Button>
        </div>
      </main>
    );
  }
}
