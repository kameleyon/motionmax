export interface Job {
  id: string;
  project_id: string | null;
  user_id?: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  task_type:
    | 'generate_video'       // script phase — all project types including cinematic
    | 'process_audio'        // audio phase (TTS)
    | 'process_images'       // images phase (Hypereal / Replicate)
    | 'finalize_generation'  // finalize phase (cost recording + status)
    | 'export_video'         // video export (FFmpeg)
    | 'generate_cinematic'   // reserved alias — maps to generate_video handler
    | 'generate_topics';     // autopost intake — produces 15 topic ideas
  progress?: number;
  payload: any;
  result?: any;
  created_at: string;
}