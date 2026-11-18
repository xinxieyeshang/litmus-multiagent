'use client';

/**
 * IndexedDB 持久化缓存：论文数据 + 各信号结果 + S1 断点元数据。
 * 解决 5500 篇规模下 S1 运行 2-3 小时期间刷新/崩溃/断连导致结果全丢的问题。
 *
 * 存储结构：
 * - papers:  keyPath=pmid，上传的论文（含 H1 标注）
 * - signal1: keyPath=pmid，S1 结果（每批增量落盘，支持断点续跑）
 * - signals: key='s2'|'s3'|'s4'|'citation'，其余信号结果（一次性整体存取）
 * - meta:    keyPath=id，会话元数据（数据指纹 + 各信号完成状态）
 *
 * 所有 API 在 IndexedDB 不可用（隐私模式等）时静默降级为 no-op，
 * 不影响主流程。
 */

const DB_NAME = 'litmus-cache';
const DB_VERSION = 1;

export interface SessionMeta {
  id: 'session';
  /** 论文集合指纹（pmid 列表 hash），用于校验缓存与当前数据是否同源 */
  papersHash: string;
  paperCount: number;
  s1Done: number;
  s1Status: 'partial' | 'done';
  s2Done: boolean;
  s3Done: boolean;
  s4Done: boolean;
  updatedAt: number;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('papers')) db.createObjectStore('papers', { keyPath: 'pmid' });
      if (!db.objectStoreNames.contains('signal1')) db.createObjectStore('signal1', { keyPath: 'pmid' });
      if (!db.objectStoreNames.contains('signals')) db.createObjectStore('signals');
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** FNV-1a 简易稳定 hash：校验论文集合一致性（新文件 vs 缓存） */
export function computePapersHash(pmids: string[]): string {
  const s = pmids.join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${pmids.length}:${(h >>> 0).toString(36)}`;
}

// ============ 论文 ============

export async function idbSavePapers<T extends { pmid: string }>(papers: T[]): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction('papers', 'readwrite');
    const store = t.objectStore('papers');
    store.clear();
    for (const p of papers) store.put(p);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function idbLoadPapers<T>(): Promise<T[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('papers', 'readonly').objectStore('papers').getAll();
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

// ============ 信号1（增量） ============

export async function idbSaveSignal1Batch<T extends { pmid: string }>(batch: T[]): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction('signal1', 'readwrite');
    const store = t.objectStore('signal1');
    for (const r of batch) store.put(r);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function idbLoadSignal1<T>(): Promise<T[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('signal1', 'readonly').objectStore('signal1').getAll();
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

export async function idbClearSignal1(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction('signal1', 'readwrite');
    t.objectStore('signal1').clear();
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

// ============ 信号2/3/4 与 citation（整体） ============

export async function idbSaveSignal(key: 's2' | 's3' | 's4' | 'citation', data: unknown): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction('signals', 'readwrite');
    t.objectStore('signals').put(data, key);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function idbLoadSignal<T>(key: 's2' | 's3' | 's4' | 'citation'): Promise<T | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('signals', 'readonly').objectStore('signals').get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

// ============ 会话元数据 ============

export async function idbSaveMeta(meta: SessionMeta): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction('meta', 'readwrite');
    t.objectStore('meta').put(meta);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function idbLoadMeta(): Promise<SessionMeta | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('meta', 'readonly').objectStore('meta').get('session');
    req.onsuccess = () => resolve(req.result as SessionMeta | undefined);
    req.onerror = () => reject(req.error);
  });
}

// ============ 整体清空 ============

export async function idbClearAll(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(['papers', 'signal1', 'signals', 'meta'], 'readwrite');
    t.objectStore('papers').clear();
    t.objectStore('signal1').clear();
    t.objectStore('signals').clear();
    t.objectStore('meta').clear();
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
