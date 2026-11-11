import type { Organization } from '../../contracts/index.js';

export type DocumentRole = 'baseline' | 'state' | 'change' | 'decision' | 'verification';
export type DocumentStage = 'planned' | 'confirmed' | 'implemented' | 'verified';
export interface Replacement { entryIds: string[]; scope: string; effect: string }
export interface TagSnapshot {
  status: 'known' | 'unknown'; source: 'explicit' | 'resource-meta' | 'unavailable-history';
  items: { id: string; name: string; aliases: string[]; definitionRevision: number; source: string }[];
}
/** 每条记录固定原件与派生输入；后续标签、原件变化不改写此快照。 */
export interface ProjectEntry {
  id: string; resourceId: string; contentVersion: number; contentHash: string;
  title: string; role: DocumentRole; projectVersion: string; recordedAt: string; stage: DocumentStage;
  replaces?: Replacement; requestId?: string; requestFingerprint?: string;
  snapshot: {
    tags: TagSnapshot; keywords: string[]; parseStatus: 'parsed'; parserVersion: string;
    keywordProcessorVersion: string; filename: string; format: string; originalNameKnown: boolean;
    capturedAt: string; sourceMetaRevision: number;
  };
}
/** Organization.data是项目清单唯一权威；没有第二份资源meta项目索引。 */
export interface ProjectData { schemaVersion: 1; description: string; entries: ProjectEntry[] }
export interface AddProjectEntryInput {
  projectId: string; resourceId: string; title: string; role: DocumentRole; projectVersion: string;
  stage: DocumentStage; contentVersion?: number; recordedAt?: string; tags?: string[];
  replaces?: Replacement; requestId?: string;
}
export interface ProjectQueryInput {
  projectId: string; asOfVersion?: string; tags?: string[]; keywords?: string[];
  includeBaseline?: boolean; offset?: number; limit?: number;
}
export interface ReplacementNotice { entryId: string; stage: DocumentStage; scope: string; effect: string }
export interface ProjectEntryView {
  entry: ProjectEntry; replacement: { replacedBy: ReplacementNotice[] }; matchReasons: string[];
}
export interface ProjectDocument extends ProjectEntryView { text: string }
export interface ProjectPage<T> { projectId: string; items: T[]; total: number; offset: number; limit: number; hasMore: boolean }
export interface ProjectQueryResult extends ProjectPage<ProjectDocument> {
  baseline: ProjectDocument | null; baselineEntryId: string | null;
}
export interface ProjectTrackingApi {
  create(input: { name: string; description?: string }): Promise<Organization>;
  list(): Promise<Organization[]>; get(projectId: string): Promise<Organization>;
  add(input: AddProjectEntryInput): Promise<{ projectId: string; entry: ProjectEntry; replayed: boolean }>;
  documents(input: ProjectQueryInput): Promise<ProjectPage<ProjectEntryView>>;
  read(input: { projectId: string; entryId: string; asOfVersion?: string }): Promise<ProjectDocument>;
  query(input: ProjectQueryInput): Promise<ProjectQueryResult>;
}
