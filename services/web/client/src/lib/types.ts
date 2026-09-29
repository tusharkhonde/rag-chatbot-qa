export type Role = 'admin' | 'user';
export interface User { id: string; email: string; name: string; role: Role }
export interface AdminUser extends User { disabled: boolean; createdAt: string; lastLoginAt: string | null }
export interface Collection { id: string; name: string; version: number; createdAt: string }
export interface DocumentSummary { id: string; filename: string; mimeType: string; status: string; chunkCount: number; createdAt: string }
export interface Citation { index: number; label: string; filename: string; chunkId: string; snippet: string }
export interface SourceInfo { index: number; label: string; chunkId: string; score: number }
export interface AnswerResult {
  answer: string;
  citations: Citation[];
  invalidCitations: number[];
  sources: SourceInfo[];
  refused: boolean;
  cached: boolean;
  timings: Record<string, number>;
}
