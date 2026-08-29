import type { WorkerEnv } from "@/alchemy.run";

interface WorkerModule {
  default: {
    fetch: (request: Request, env: WorkerEnv) => Promise<Response>;
    scheduled: (
      controller: ScheduledController,
      env: WorkerEnv,
      context: ExecutionContext
    ) => void;
  };
}

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      readonly BANK_STORE: WorkerEnv["BANK_STORE"];
    }

    interface GlobalProps {
      mainModule: WorkerModule;
    }
  }

  interface Env extends WorkerEnv {
    readonly BANK_STORE: WorkerEnv["BANK_STORE"];
  }
}
