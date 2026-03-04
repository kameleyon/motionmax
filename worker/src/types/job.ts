export interface Job {
  id: string;
  project_id: string;
  user_id?: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  task_type: 'generate_video' | 'generate_cinematic';
  progress?: number;
  payload: any;
  created_at: string;
}