export interface Job {
  id: string;
  project_id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  task_type: 'generate_video' | 'generate_cinematic';
  payload: any;
  created_at: string;
}