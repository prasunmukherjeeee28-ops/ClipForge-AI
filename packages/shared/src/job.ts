export type JobStatus = 'queued' | 'processing' | 'review' | 'completed' | 'failed';

export interface JobSummary {
  id: string;
  status: JobStatus;
  progress: number;
  createdAt: string;
  errorCode?: string;
}

export interface CandidateMoment {
  id: string;
  startSeconds: number;
  endSeconds: number;
  title?: string;
  transcriptExcerpt?: string;
  score?: number; // heuristic estimate, not a promise
}