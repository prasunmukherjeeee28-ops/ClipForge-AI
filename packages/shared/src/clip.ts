export interface Clip {
  id: string;
  jobId: string;
  title: string;
  durationSeconds?: number;
  aspectRatio: 'original' | '9:16' | '16:9' | '1:1';
  createdAt: string;
  playbackUrl?: string; // authorized short-lived URL
}