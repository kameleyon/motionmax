-- Clear stuck export_video job that loops on worker restart
UPDATE public.video_generation_jobs
SET
  status = 'failed',
  error_message = 'Manually cleared — stuck in processing (loop on restart)',
  updated_at = NOW()
WHERE id = '25be55d7-ef26-479d-b654-b3afe4e182db'
  AND status = 'processing';

SELECT id, status, task_type, error_message, updated_at
FROM public.video_generation_jobs
WHERE id = '25be55d7-ef26-479d-b654-b3afe4e182db';
