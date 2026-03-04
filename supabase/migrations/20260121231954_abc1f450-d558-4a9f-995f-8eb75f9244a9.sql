-- Create storage bucket for voice samples
INSERT INTO storage.buckets (id, name, public)
VALUES ('voice_samples', 'voice_samples', true)
ON CONFLICT (id) DO NOTHING;

-- Storage policies for voice_samples bucket
CREATE POLICY "Authenticated users can upload voice samples"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'voice_samples' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Authenticated users can read their own voice samples"
ON storage.objects
FOR SELECT
TO authenticated
USING (bucket_id = 'voice_samples' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Authenticated users can delete their own voice samples"
ON storage.objects
FOR DELETE
TO authenticated
USING (bucket_id = 'voice_samples' AND auth.uid()::text = (storage.foldername(name))[1]);

-- Create user_voices table
CREATE TABLE public.user_voices (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  voice_name TEXT NOT NULL,
  voice_id TEXT NOT NULL, -- ElevenLabs voice_id
  sample_url TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.user_voices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_voices FORCE ROW LEVEL SECURITY;

-- RLS policies for user_voices
CREATE POLICY "Users can view their own voices"
ON public.user_voices
FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own voices"
ON public.user_voices
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own voices"
ON public.user_voices
FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own voices"
ON public.user_voices
FOR DELETE
USING (auth.uid() = user_id);