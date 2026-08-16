/**
 * 极简 IndexedDB 封装。
 *
 * 为什么不用 localStorage：它只有 5MB 左右，长对话加上推理过程很快就撑爆，
 * 撑爆之后只能丢最旧的会话。IndexedDB 的配额是按磁盘剩余空间算的，
 * 通常几百 MB 起步，实际上够用到不用考虑。
 *
 * 为什么不用 idb / dexie：我们的访问模式只有 get / put / delete / getAll，
 * 手写一百行就够，不值得多一个依赖。
 *
 * 注意后端配置仍然留在 localStorage —— 那个要在首屏同步读出来决定渲染引导页
 * 还是主界面，走异步会闪一下。
 */

const DB_NAME = "chatweb";
const DB_VERSION = 1;

export const STORE_SESSIONS = "sessions";
export const STORE_MODEL_CACHE = "modelCache";

let connection: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (connection) return connection;

  connection = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("这个浏览器不支持 IndexedDB"));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        const store = db.createObjectStore(STORE_SESSIONS, { keyPath: "id" });
        // 按后端隔离 + 按更新时间排序，是列表页唯一的查询模式
        store.createIndex("byScope", ["scope", "updatedAt"]);
      }
      if (!db.objectStoreNames.contains(STORE_MODEL_CACHE)) {
        db.createObjectStore(STORE_MODEL_CACHE, { keyPath: "backendId" });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      // 另一个标签页触发了升级时，当前连接必须让路，否则会阻塞升级
      db.onversionchange = () => {
        db.close();
        connection = null;
      };
      resolve(db);
    };

    request.onerror = () => reject(request.error ?? new Error("打不开本地数据库"));
    // 隐私模式下有些浏览器会一直挂着不返回
    request.onblocked = () => reject(new Error("本地数据库被其它标签页占用，刷新一下试试"));
  });

  // 失败之后允许下次重试，不要把失败的 promise 永久缓存
  connection.catch(() => { connection = null; });
  return connection;
}

function runTransaction<T>(
  storeName: string,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(storeName, mode);
        const request = action(transaction.objectStore(storeName));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("数据库操作失败"));
        transaction.onabort = () => reject(transaction.error ?? new Error("数据库事务被中断"));
      }),
  );
}

export function idbGet<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
  return runTransaction<T | undefined>(storeName, "readonly", (store) => store.get(key));
}

export function idbPut<T>(storeName: string, value: T): Promise<IDBValidKey> {
  return runTransaction(storeName, "readwrite", (store) => store.put(value as unknown as never));
}

export function idbDelete(storeName: string, key: IDBValidKey): Promise<undefined> {
  return runTransaction(storeName, "readwrite", (store) => store.delete(key));
}

/** 按 scope 取全部，已按 updatedAt 升序，调用方通常要 reverse。 */
export function idbGetByScope<T>(storeName: string, indexName: string, scope: string): Promise<T[]> {
  return open().then(
    (db) =>
      new Promise<T[]>((resolve, reject) => {
        const transaction = db.transaction(storeName, "readonly");
        const index = transaction.objectStore(storeName).index(indexName);
        // 复合键 [scope, updatedAt] 的范围查询：固定 scope，updatedAt 取全域
        const range = IDBKeyRange.bound([scope, -Infinity], [scope, Infinity]);
        const request = index.getAll(range);
        request.onsuccess = () => resolve(request.result as T[]);
        request.onerror = () => reject(request.error ?? new Error("读取失败"));
      }),
  );
}

/** 估算已用配额，用来在设置里显示"占用了多少空间"。 */
export async function estimateUsage(): Promise<{ usage: number; quota: number } | null> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) return null;
  const estimate = await navigator.storage.estimate();
  return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
}
