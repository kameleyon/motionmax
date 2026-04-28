export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      admin_logs: {
        Row: {
          action: string
          admin_id: string | null
          created_at: string
          details: Json | null
          id: string
          ip_address: string | null
          target_id: string | null
          target_type: string
          updated_at: string
          user_agent: string | null
        }
        Insert: {
          action: string
          admin_id?: string | null
          created_at?: string
          details?: Json | null
          id?: string
          ip_address?: string | null
          target_id?: string | null
          target_type: string
          updated_at?: string
          user_agent?: string | null
        }
        Update: {
          action?: string
          admin_id?: string | null
          created_at?: string
          details?: Json | null
          id?: string
          ip_address?: string | null
          target_id?: string | null
          target_type?: string
          updated_at?: string
          user_agent?: string | null
        }
        Relationships: []
      }
      api_call_logs: {
        Row: {
          cost: number | null
          created_at: string
          error_message: string | null
          generation_id: string | null
          id: string
          model: string
          provider: string
          queue_time_ms: number | null
          running_time_ms: number | null
          status: string
          total_duration_ms: number | null
          updated_at: string
          user_id: string | null
        }
        Insert: {
          cost?: number | null
          created_at?: string
          error_message?: string | null
          generation_id?: string | null
          id?: string
          model: string
          provider: string
          queue_time_ms?: number | null
          running_time_ms?: number | null
          status?: string
          total_duration_ms?: number | null
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          cost?: number | null
          created_at?: string
          error_message?: string | null
          generation_id?: string | null
          id?: string
          model?: string
          provider?: string
          queue_time_ms?: number | null
          running_time_ms?: number | null
          status?: string
          total_duration_ms?: number | null
          updated_at?: string
          user_id?: string | null
        }
        Relationships: []
      }
      app_settings: {
        Row: {
          key: string
          updated_at: string
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string
          value: Json
        }
        Update: {
          key?: string
          updated_at?: string
          value?: Json
        }
        Relationships: []
      }
      autopost_publish_jobs: {
        Row: {
          attempts: number
          caption: string | null
          created_at: string
          error_code: string | null
          error_message: string | null
          id: string
          last_attempt_at: string | null
          platform: string
          platform_post_id: string | null
          platform_post_url: string | null
          run_id: string
          scheduled_for: string | null
          social_account_id: string
          status: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          caption?: string | null
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          id?: string
          last_attempt_at?: string | null
          platform: string
          platform_post_id?: string | null
          platform_post_url?: string | null
          run_id: string
          scheduled_for?: string | null
          social_account_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          caption?: string | null
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          id?: string
          last_attempt_at?: string | null
          platform?: string
          platform_post_id?: string | null
          platform_post_url?: string | null
          run_id?: string
          scheduled_for?: string | null
          social_account_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "autopost_publish_jobs_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "autopost_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "autopost_publish_jobs_social_account_id_fkey"
            columns: ["social_account_id"]
            isOneToOne: false
            referencedRelation: "autopost_social_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      autopost_runs: {
        Row: {
          error_summary: string | null
          fired_at: string
          id: string
          prompt_resolved: string
          schedule_id: string
          status: string
          thumbnail_storage_path: string | null
          thumbnail_url: string | null
          topic: string | null
          video_job_id: string | null
        }
        Insert: {
          error_summary?: string | null
          fired_at?: string
          id?: string
          prompt_resolved: string
          schedule_id: string
          status?: string
          thumbnail_storage_path?: string | null
          thumbnail_url?: string | null
          topic?: string | null
          video_job_id?: string | null
        }
        Update: {
          error_summary?: string | null
          fired_at?: string
          id?: string
          prompt_resolved?: string
          schedule_id?: string
          status?: string
          thumbnail_storage_path?: string | null
          thumbnail_url?: string | null
          topic?: string | null
          video_job_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "autopost_runs_schedule_id_fkey"
            columns: ["schedule_id"]
            isOneToOne: false
            referencedRelation: "autopost_schedules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "autopost_runs_video_job_id_fkey"
            columns: ["video_job_id"]
            isOneToOne: false
            referencedRelation: "video_generation_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      autopost_schedules: {
        Row: {
          active: boolean
          ai_disclosure: boolean
          caption_template: string | null
          created_at: string
          cron_expression: string
          duration_seconds: number
          hashtags: string[] | null
          id: string
          motion_preset: string | null
          name: string
          next_fire_at: string
          prompt_template: string
          resolution: string
          target_account_ids: string[]
          timezone: string
          topic_pool: string[] | null
          updated_at: string
          user_id: string
        }
        Insert: {
          active?: boolean
          ai_disclosure?: boolean
          caption_template?: string | null
          created_at?: string
          cron_expression: string
          duration_seconds?: number
          hashtags?: string[] | null
          id?: string
          motion_preset?: string | null
          name: string
          next_fire_at: string
          prompt_template: string
          resolution?: string
          target_account_ids: string[]
          timezone?: string
          topic_pool?: string[] | null
          updated_at?: string
          user_id: string
        }
        Update: {
          active?: boolean
          ai_disclosure?: boolean
          caption_template?: string | null
          created_at?: string
          cron_expression?: string
          duration_seconds?: number
          hashtags?: string[] | null
          id?: string
          motion_preset?: string | null
          name?: string
          next_fire_at?: string
          prompt_template?: string
          resolution?: string
          target_account_ids?: string[]
          timezone?: string
          topic_pool?: string[] | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      autopost_social_accounts: {
        Row: {
          access_token: string
          avatar_url: string | null
          connected_at: string
          display_name: string
          id: string
          last_error: string | null
          platform: string
          platform_account_id: string
          provider_metadata: Json
          refresh_token: string | null
          scopes: string[]
          status: string
          token_expires_at: string | null
          user_id: string
        }
        Insert: {
          access_token: string
          avatar_url?: string | null
          connected_at?: string
          display_name: string
          id?: string
          last_error?: string | null
          platform: string
          platform_account_id: string
          provider_metadata?: Json
          refresh_token?: string | null
          scopes: string[]
          status?: string
          token_expires_at?: string | null
          user_id: string
        }
        Update: {
          access_token?: string
          avatar_url?: string | null
          connected_at?: string
          display_name?: string
          id?: string
          last_error?: string | null
          platform?: string
          platform_account_id?: string
          provider_metadata?: Json
          refresh_token?: string | null
          scopes?: string[]
          status?: string
          token_expires_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      credit_transactions: {
        Row: {
          amount: number
          created_at: string
          description: string | null
          id: string
          idempotency_key: string | null
          stripe_payment_intent_id: string | null
          transaction_type: string
          user_id: string
        }
        Insert: {
          amount: number
          created_at?: string
          description?: string | null
          id?: string
          idempotency_key?: string | null
          stripe_payment_intent_id?: string | null
          transaction_type: string
          user_id: string
        }
        Update: {
          amount?: number
          created_at?: string
          description?: string | null
          id?: string
          idempotency_key?: string | null
          stripe_payment_intent_id?: string | null
          transaction_type?: string
          user_id?: string
        }
        Relationships: []
      }
      dead_letter_jobs: {
        Row: {
          attempts: number
          created_at: string
          error_message: string | null
          failed_at: string
          id: string
          payload: Json | null
          project_id: string | null
          source_job_id: string
          task_type: string
          user_id: string | null
          worker_id: string | null
        }
        Insert: {
          attempts?: number
          created_at?: string
          error_message?: string | null
          failed_at?: string
          id?: string
          payload?: Json | null
          project_id?: string | null
          source_job_id: string
          task_type: string
          user_id?: string | null
          worker_id?: string | null
        }
        Update: {
          attempts?: number
          created_at?: string
          error_message?: string | null
          failed_at?: string
          id?: string
          payload?: Json | null
          project_id?: string | null
          source_job_id?: string
          task_type?: string
          user_id?: string | null
          worker_id?: string | null
        }
        Relationships: []
      }
      deletion_requests: {
        Row: {
          email: string | null
          error_message: string | null
          id: string
          requested_at: string | null
          scheduled_at: string | null
          status: string | null
          user_id: string
        }
        Insert: {
          email?: string | null
          error_message?: string | null
          id?: string
          requested_at?: string | null
          scheduled_at?: string | null
          status?: string | null
          user_id: string
        }
        Update: {
          email?: string | null
          error_message?: string | null
          id?: string
          requested_at?: string | null
          scheduled_at?: string | null
          status?: string | null
          user_id?: string
        }
        Relationships: []
      }
      deletion_tasks: {
        Row: {
          attempts: number
          created_at: string
          id: string
          payload: Json
          status: string
          task_type: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          id?: string
          payload: Json
          status?: string
          task_type: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          created_at?: string
          id?: string
          payload?: Json
          status?: string
          task_type?: string
          updated_at?: string
        }
        Relationships: []
      }
      feature_flags: {
        Row: {
          description: string | null
          enabled: boolean
          flag_name: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          description?: string | null
          enabled?: boolean
          flag_name: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          description?: string | null
          enabled?: boolean
          flag_name?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      generation_archives: {
        Row: {
          audio_url: string | null
          deleted_at: string
          error_message: string | null
          id: string
          original_completed_at: string | null
          original_created_at: string
          original_id: string
          progress: number
          project_id: string
          scenes: Json | null
          script: string | null
          status: string
          user_id: string | null
          video_url: string | null
        }
        Insert: {
          audio_url?: string | null
          deleted_at?: string
          error_message?: string | null
          id?: string
          original_completed_at?: string | null
          original_created_at: string
          original_id: string
          progress?: number
          project_id: string
          scenes?: Json | null
          script?: string | null
          status: string
          user_id?: string | null
          video_url?: string | null
        }
        Update: {
          audio_url?: string | null
          deleted_at?: string
          error_message?: string | null
          id?: string
          original_completed_at?: string | null
          original_created_at?: string
          original_id?: string
          progress?: number
          project_id?: string
          scenes?: Json | null
          script?: string | null
          status?: string
          user_id?: string | null
          video_url?: string | null
        }
        Relationships: []
      }
      generation_costs: {
        Row: {
          created_at: string
          generation_id: string
          google_tts_cost: number | null
          hypereal_cost: number | null
          id: string
          openrouter_cost: number | null
          replicate_cost: number | null
          total_cost: number | null
          user_id: string | null
        }
        Insert: {
          created_at?: string
          generation_id: string
          google_tts_cost?: number | null
          hypereal_cost?: number | null
          id?: string
          openrouter_cost?: number | null
          replicate_cost?: number | null
          total_cost?: number | null
          user_id?: string | null
        }
        Update: {
          created_at?: string
          generation_id?: string
          google_tts_cost?: number | null
          hypereal_cost?: number | null
          id?: string
          openrouter_cost?: number | null
          replicate_cost?: number | null
          total_cost?: number | null
          user_id?: string | null
        }
        Relationships: []
      }
      generations: {
        Row: {
          archived_at: string | null
          audio_url: string | null
          completed_at: string | null
          created_at: string
          credits_deducted: number | null
          error_message: string | null
          id: string
          master_audio_duration_ms: number | null
          master_audio_url: string | null
          music_url: string | null
          progress: number
          project_id: string
          retried_from: string | null
          scenes: Json | null
          script: string | null
          sfx_url: string | null
          started_at: string | null
          status: string
          stems: Json | null
          updated_at: string
          user_id: string
          video_url: string | null
        }
        Insert: {
          archived_at?: string | null
          audio_url?: string | null
          completed_at?: string | null
          created_at?: string
          credits_deducted?: number | null
          error_message?: string | null
          id?: string
          master_audio_duration_ms?: number | null
          master_audio_url?: string | null
          music_url?: string | null
          progress?: number
          project_id: string
          retried_from?: string | null
          scenes?: Json | null
          script?: string | null
          sfx_url?: string | null
          started_at?: string | null
          status?: string
          stems?: Json | null
          updated_at?: string
          user_id: string
          video_url?: string | null
        }
        Update: {
          archived_at?: string | null
          audio_url?: string | null
          completed_at?: string | null
          created_at?: string
          credits_deducted?: number | null
          error_message?: string | null
          id?: string
          master_audio_duration_ms?: number | null
          master_audio_url?: string | null
          music_url?: string | null
          progress?: number
          project_id?: string
          retried_from?: string | null
          scenes?: Json | null
          script?: string | null
          sfx_url?: string | null
          started_at?: string | null
          status?: string
          stems?: Json | null
          updated_at?: string
          user_id?: string
          video_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "generations_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "generations_retried_from_fkey"
            columns: ["retried_from"]
            isOneToOne: false
            referencedRelation: "generations"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          accepted_policy_at: string | null
          accepted_policy_version: string | null
          avatar_url: string | null
          created_at: string
          deleted_at: string | null
          display_name: string | null
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          accepted_policy_at?: string | null
          accepted_policy_version?: string | null
          avatar_url?: string | null
          created_at?: string
          deleted_at?: string | null
          display_name?: string | null
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          accepted_policy_at?: string | null
          accepted_policy_version?: string | null
          avatar_url?: string | null
          created_at?: string
          deleted_at?: string | null
          display_name?: string | null
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      project_characters: {
        Row: {
          character_name: string
          created_at: string | null
          description: string
          id: string
          project_id: string
          reference_image_url: string
          user_id: string
        }
        Insert: {
          character_name: string
          created_at?: string | null
          description: string
          id?: string
          project_id: string
          reference_image_url: string
          user_id: string
        }
        Update: {
          character_name?: string
          created_at?: string | null
          description?: string
          id?: string
          project_id?: string
          reference_image_url?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_characters_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_shares: {
        Row: {
          created_at: string
          expires_at: string | null
          id: string
          project_id: string
          share_token: string
          user_id: string
          view_count: number
        }
        Insert: {
          created_at?: string
          expires_at?: string | null
          id?: string
          project_id: string
          share_token: string
          user_id: string
          view_count?: number
        }
        Update: {
          created_at?: string
          expires_at?: string | null
          id?: string
          project_id?: string
          share_token?: string
          user_id?: string
          view_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "project_shares_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      projects: {
        Row: {
          brand_mark: string | null
          character_consistency_enabled: boolean | null
          character_description: string | null
          character_images: Json | null
          content: string
          created_at: string
          custom_style: string | null
          custom_style_image: string | null
          description: string | null
          disable_expressions: boolean
          format: string
          id: string
          inspiration_style: string | null
          intake_settings: Json
          is_favorite: boolean
          length: string
          presenter_focus: string | null
          previous_export_url: string | null
          project_type: string
          status: string
          story_genre: string | null
          story_tone: string | null
          style: string
          thumbnail_url: string | null
          title: string
          updated_at: string
          user_id: string
          voice_id: string | null
          voice_inclination: string | null
          voice_name: string | null
          voice_type: string | null
        }
        Insert: {
          brand_mark?: string | null
          character_consistency_enabled?: boolean | null
          character_description?: string | null
          character_images?: Json | null
          content?: string
          created_at?: string
          custom_style?: string | null
          custom_style_image?: string | null
          description?: string | null
          disable_expressions?: boolean
          format?: string
          id?: string
          inspiration_style?: string | null
          intake_settings?: Json
          is_favorite?: boolean
          length?: string
          presenter_focus?: string | null
          previous_export_url?: string | null
          project_type?: string
          status?: string
          story_genre?: string | null
          story_tone?: string | null
          style?: string
          thumbnail_url?: string | null
          title: string
          updated_at?: string
          user_id: string
          voice_id?: string | null
          voice_inclination?: string | null
          voice_name?: string | null
          voice_type?: string | null
        }
        Update: {
          brand_mark?: string | null
          character_consistency_enabled?: boolean | null
          character_description?: string | null
          character_images?: Json | null
          content?: string
          created_at?: string
          custom_style?: string | null
          custom_style_image?: string | null
          description?: string | null
          disable_expressions?: boolean
          format?: string
          id?: string
          inspiration_style?: string | null
          intake_settings?: Json
          is_favorite?: boolean
          length?: string
          presenter_focus?: string | null
          previous_export_url?: string | null
          project_type?: string
          status?: string
          story_genre?: string | null
          story_tone?: string | null
          style?: string
          thumbnail_url?: string | null
          title?: string
          updated_at?: string
          user_id?: string
          voice_id?: string | null
          voice_inclination?: string | null
          voice_name?: string | null
          voice_type?: string | null
        }
        Relationships: []
      }
      rate_limits: {
        Row: {
          created_at: string
          id: string
          ip_address: string | null
          key: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          ip_address?: string | null
          key: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          ip_address?: string | null
          key?: string
          user_id?: string | null
        }
        Relationships: []
      }
      referral_codes: {
        Row: {
          code: string
          created_at: string
          id: string
          total_credits_earned: number
          total_referrals: number
          user_id: string
        }
        Insert: {
          code: string
          created_at?: string
          id?: string
          total_credits_earned?: number
          total_referrals?: number
          user_id: string
        }
        Update: {
          code?: string
          created_at?: string
          id?: string
          total_credits_earned?: number
          total_referrals?: number
          user_id?: string
        }
        Relationships: []
      }
      referral_uses: {
        Row: {
          completed_at: string | null
          created_at: string
          id: string
          referred_credits_awarded: number
          referred_id: string
          referrer_credits_awarded: number
          referrer_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          id?: string
          referred_credits_awarded?: number
          referred_id: string
          referrer_credits_awarded?: number
          referrer_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          id?: string
          referred_credits_awarded?: number
          referred_id?: string
          referrer_credits_awarded?: number
          referrer_id?: string
        }
        Relationships: []
      }
      scene_versions: {
        Row: {
          audio_url: string | null
          change_type: string
          created_at: string
          duration: number | null
          generation_id: string
          id: string
          image_url: string | null
          image_urls: Json | null
          scene_index: number
          version_number: number | null
          video_url: string | null
          visual_prompt: string | null
          voiceover: string | null
        }
        Insert: {
          audio_url?: string | null
          change_type?: string
          created_at?: string
          duration?: number | null
          generation_id: string
          id?: string
          image_url?: string | null
          image_urls?: Json | null
          scene_index: number
          version_number?: number | null
          video_url?: string | null
          visual_prompt?: string | null
          voiceover?: string | null
        }
        Update: {
          audio_url?: string | null
          change_type?: string
          created_at?: string
          duration?: number | null
          generation_id?: string
          id?: string
          image_url?: string | null
          image_urls?: Json | null
          scene_index?: number
          version_number?: number | null
          video_url?: string | null
          visual_prompt?: string | null
          voiceover?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "scene_versions_generation_id_fkey"
            columns: ["generation_id"]
            isOneToOne: false
            referencedRelation: "generations"
            referencedColumns: ["id"]
          },
        ]
      }
      subscriptions: {
        Row: {
          cancel_at_period_end: boolean | null
          created_at: string
          current_period_end: string | null
          current_period_start: string | null
          id: string
          is_manual_subscription: boolean
          plan_name: string
          status: Database["public"]["Enums"]["subscription_status"]
          stripe_customer_id: string
          stripe_subscription_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          cancel_at_period_end?: boolean | null
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          is_manual_subscription?: boolean
          plan_name?: string
          status?: Database["public"]["Enums"]["subscription_status"]
          stripe_customer_id: string
          stripe_subscription_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          cancel_at_period_end?: boolean | null
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          is_manual_subscription?: boolean
          plan_name?: string
          status?: Database["public"]["Enums"]["subscription_status"]
          stripe_customer_id?: string
          stripe_subscription_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      system_logs: {
        Row: {
          category: string
          created_at: string
          details: Json | null
          event_type: string
          generation_id: string | null
          id: string
          message: string
          project_id: string | null
          user_id: string | null
        }
        Insert: {
          category: string
          created_at?: string
          details?: Json | null
          event_type: string
          generation_id?: string | null
          id?: string
          message: string
          project_id?: string | null
          user_id?: string | null
        }
        Update: {
          category?: string
          created_at?: string
          details?: Json | null
          event_type?: string
          generation_id?: string | null
          id?: string
          message?: string
          project_id?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      user_api_keys: {
        Row: {
          created_at: string
          gemini_api_key: string | null
          id: string
          replicate_api_token: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          gemini_api_key?: string | null
          id?: string
          replicate_api_token?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          gemini_api_key?: string | null
          id?: string
          replicate_api_token?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_credits: {
        Row: {
          created_at: string
          credits_balance: number
          daily_credits_granted_at: string | null
          id: string
          total_purchased: number
          total_used: number
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          credits_balance?: number
          daily_credits_granted_at?: string | null
          id?: string
          total_purchased?: number
          total_used?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          credits_balance?: number
          daily_credits_granted_at?: string | null
          id?: string
          total_purchased?: number
          total_used?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_flags: {
        Row: {
          created_at: string
          details: string | null
          flag_type: string
          flagged_by: string | null
          id: string
          reason: string
          resolution_notes: string | null
          resolved_at: string | null
          resolved_by: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          details?: string | null
          flag_type: string
          flagged_by?: string | null
          id?: string
          reason: string
          resolution_notes?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          details?: string | null
          flag_type?: string
          flagged_by?: string | null
          id?: string
          reason?: string
          resolution_notes?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_voices: {
        Row: {
          created_at: string
          description: string | null
          id: string
          original_sample_path: string | null
          provider: string
          sample_url: string
          user_id: string
          voice_id: string
          voice_name: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          original_sample_path?: string | null
          provider?: string
          sample_url: string
          user_id: string
          voice_id: string
          voice_name: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          original_sample_path?: string | null
          provider?: string
          sample_url?: string
          user_id?: string
          voice_id?: string
          voice_name?: string
        }
        Relationships: []
      }
      video_generation_jobs: {
        Row: {
          archived_at: string | null
          created_at: string | null
          depends_on: string[] | null
          error_message: string | null
          id: string
          payload: Json
          progress: number | null
          project_id: string | null
          result: Json | null
          retried_from: string | null
          status: string
          task_type: string
          updated_at: string | null
          user_id: string
          worker_id: string | null
        }
        Insert: {
          archived_at?: string | null
          created_at?: string | null
          depends_on?: string[] | null
          error_message?: string | null
          id?: string
          payload: Json
          progress?: number | null
          project_id?: string | null
          result?: Json | null
          retried_from?: string | null
          status?: string
          task_type: string
          updated_at?: string | null
          user_id: string
          worker_id?: string | null
        }
        Update: {
          archived_at?: string | null
          created_at?: string | null
          depends_on?: string[] | null
          error_message?: string | null
          id?: string
          payload?: Json
          progress?: number | null
          project_id?: string | null
          result?: Json | null
          retried_from?: string | null
          status?: string
          task_type?: string
          updated_at?: string | null
          user_id?: string
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "video_generation_jobs_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "video_generation_jobs_retried_from_fkey"
            columns: ["retried_from"]
            isOneToOne: false
            referencedRelation: "video_generation_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      voice_consents: {
        Row: {
          consented_at: string
          id: string
          ip_address: string | null
          user_agent: string | null
          user_id: string
          voice_id: string
        }
        Insert: {
          consented_at?: string
          id?: string
          ip_address?: string | null
          user_agent?: string | null
          user_id: string
          voice_id: string
        }
        Update: {
          consented_at?: string
          id?: string
          ip_address?: string | null
          user_agent?: string | null
          user_id?: string
          voice_id?: string
        }
        Relationships: []
      }
      webhook_events: {
        Row: {
          event_id: string
          event_type: string
          id: string
          processed_at: string
        }
        Insert: {
          event_id: string
          event_type: string
          id?: string
          processed_at?: string
        }
        Update: {
          event_id?: string
          event_type?: string
          id?: string
          processed_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      admin_mv_daily_active_users: {
        Row: {
          active_users: number | null
          day: string | null
        }
        Relationships: []
      }
      admin_mv_daily_generation_stats: {
        Row: {
          day: string | null
          generation_count: number | null
          status: string | null
        }
        Relationships: []
      }
      admin_mv_daily_job_counts: {
        Row: {
          day: string | null
          job_count: number | null
          status: string | null
        }
        Relationships: []
      }
      admin_mv_daily_revenue: {
        Row: {
          day: string | null
          total_credits_sold: number | null
          transaction_count: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      admin_cancel_job_with_refund: {
        Args: { p_job_id: string; p_reason?: string; p_refund_credits?: number }
        Returns: Json
      }
      admin_get_app_setting: { Args: { setting_key: string }; Returns: Json }
      admin_get_user_emails: {
        Args: { user_ids: string[] }
        Returns: {
          email: string
          user_id: string
        }[]
      }
      admin_get_user_id_by_email: {
        Args: { email_param: string }
        Returns: string
      }
      admin_global_search: {
        Args: { limit_per_table?: number; q: string }
        Returns: {
          created_at: string
          id: string
          kind: string
          rank: number
          subtitle: string
          title: string
        }[]
      }
      admin_list_app_settings: {
        Args: never
        Returns: {
          key: string
          updated_at: string
          value: Json
        }[]
      }
      admin_resolve_all_flags: {
        Args: { resolution_notes?: string; target_user_id: string }
        Returns: number
      }
      admin_restore_missing_refunds: {
        Args: { p_days_back?: number; p_user_id: string }
        Returns: number
      }
      admin_retry_generation: {
        Args: { generation_id: string }
        Returns: string
      }
      admin_retry_user_generation: {
        Args: { generation_id: string }
        Returns: string
      }
      admin_set_flags_auto_resolve_days: {
        Args: { days: number }
        Returns: number
      }
      admin_set_worker_concurrency_override: {
        Args: { value: number }
        Returns: Json
      }
      admin_soft_delete_user: {
        Args: { target_user_id: string }
        Returns: number
      }
      apply_referral_code: {
        Args: { p_code: string; p_referred_user_id: string }
        Returns: string
      }
      auto_resolve_stale_flags: { Args: never; Returns: number }
      autopost_advance_next_fire: {
        Args: { cron_expr: string; current_fire: string; tz: string }
        Returns: string
      }
      autopost_cron_field_match: {
        Args: {
          field: string
          field_max: number
          field_min: number
          value: number
        }
        Returns: boolean
      }
      autopost_resolve_prompt: {
        Args: { fired_at: string; template: string; topic: string; tz: string }
        Returns: string
      }
      autopost_resolve_topic: {
        Args: {
          schedule_row: Database["public"]["Tables"]["autopost_schedules"]["Row"]
        }
        Returns: string
      }
      autopost_tick: { Args: never; Returns: undefined }
      award_referral_credits: {
        Args: { p_referred_user_id: string }
        Returns: boolean
      }
      claim_pending_job:
        | {
            Args: { p_exclude_task_type?: string; p_task_type?: string }
            Returns: {
              archived_at: string | null
              created_at: string | null
              depends_on: string[] | null
              error_message: string | null
              id: string
              payload: Json
              progress: number | null
              project_id: string | null
              result: Json | null
              retried_from: string | null
              status: string
              task_type: string
              updated_at: string | null
              user_id: string
              worker_id: string | null
            }[]
            SetofOptions: {
              from: "*"
              to: "video_generation_jobs"
              isOneToOne: false
              isSetofReturn: true
            }
          }
        | {
            Args: {
              p_exclude_task_type?: string
              p_limit?: number
              p_task_type?: string
            }
            Returns: {
              archived_at: string | null
              created_at: string | null
              depends_on: string[] | null
              error_message: string | null
              id: string
              payload: Json
              progress: number | null
              project_id: string | null
              result: Json | null
              retried_from: string | null
              status: string
              task_type: string
              updated_at: string | null
              user_id: string
              worker_id: string | null
            }[]
            SetofOptions: {
              from: "*"
              to: "video_generation_jobs"
              isOneToOne: false
              isSetofReturn: true
            }
          }
        | {
            Args: {
              p_exclude_task_type?: string
              p_limit?: number
              p_task_type?: string
              p_worker_id?: string
            }
            Returns: {
              archived_at: string | null
              created_at: string | null
              depends_on: string[] | null
              error_message: string | null
              id: string
              payload: Json
              progress: number | null
              project_id: string | null
              result: Json | null
              retried_from: string | null
              status: string
              task_type: string
              updated_at: string | null
              user_id: string
              worker_id: string | null
            }[]
            SetofOptions: {
              from: "*"
              to: "video_generation_jobs"
              isOneToOne: false
              isSetofReturn: true
            }
          }
      claim_voice_clone_slot: {
        Args: {
          p_eleven_id: string
          p_language?: string
          p_limit: number
          p_model_id?: string
          p_name: string
          p_user_id: string
        }
        Returns: Json
      }
      cleanup_old_storage_objects: {
        Args: { bucket: string; retention_days?: number }
        Returns: number
      }
      deduct_credits_securely: {
        Args: {
          p_amount: number
          p_description: string
          p_idempotency_key?: string
          p_transaction_type: string
          p_user_id: string
        }
        Returns: boolean
      }
      detect_orphan_storage_files: {
        Args: never
        Returns: {
          bucket_id: string
          created_at: string
          object_name: string
          size_bytes: number
        }[]
      }
      generate_referral_code: { Args: { p_user_id: string }; Returns: string }
      get_generation_costs_summary: { Args: never; Returns: Json }
      get_shared_project: { Args: { share_token_param: string }; Returns: Json }
      grant_daily_credits: { Args: { p_user_id: string }; Returns: boolean }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      increment_user_credits: {
        Args: { p_credits: number; p_user_id: string }
        Returns: undefined
      }
      is_admin: { Args: { _user_id: string }; Returns: boolean }
      merge_job_scene_progress: {
        Args: { p_job_id: string; p_progress: Json }
        Returns: undefined
      }
      process_deletion_request: {
        Args: { p_request_id: string }
        Returns: boolean
      }
      process_deletion_requests: { Args: never; Returns: undefined }
      process_due_deletions: { Args: never; Returns: number }
      purge_old_api_call_logs: { Args: never; Returns: number }
      purge_old_archives: { Args: never; Returns: number }
      purge_old_dead_letter_jobs: { Args: never; Returns: number }
      purge_old_jobs: { Args: never; Returns: number }
      purge_old_rate_limits: { Args: never; Returns: number }
      purge_old_system_logs: { Args: never; Returns: number }
      purge_old_webhook_events: { Args: never; Returns: number }
      refresh_admin_materialized_views: { Args: never; Returns: undefined }
      refund_credits_securely: {
        Args: { p_amount: number; p_description: string; p_user_id: string }
        Returns: boolean
      }
      run_data_retention: { Args: never; Returns: Json }
      sanitize_jsonb_value: {
        Args: { sensitive_keys: string[]; val: Json }
        Returns: Json
      }
      save_scene_version: {
        Args: {
          p_audio_url?: string
          p_change_type?: string
          p_duration?: number
          p_generation_id: string
          p_image_url?: string
          p_image_urls?: string
          p_scene_index: number
          p_video_url?: string
          p_visual_prompt?: string
          p_voiceover?: string
        }
        Returns: string
      }
      update_scene_at_index: {
        Args: {
          p_generation_id: string
          p_progress?: number
          p_scene_data: Json
          p_scene_index: number
        }
        Returns: undefined
      }
      update_scene_field: {
        Args: {
          p_field: string
          p_generation_id: string
          p_scene_index: number
          p_value: string
        }
        Returns: undefined
      }
      update_scene_field_json: {
        Args: {
          p_field: string
          p_generation_id: string
          p_scene_index: number
          p_value: Json
        }
        Returns: undefined
      }
    }
    Enums: {
      app_role: "admin" | "moderator" | "user"
      subscription_status:
        | "active"
        | "canceled"
        | "past_due"
        | "trialing"
        | "incomplete"
        | "incomplete_expired"
        | "unpaid"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "moderator", "user"],
      subscription_status: [
        "active",
        "canceled",
        "past_due",
        "trialing",
        "incomplete",
        "incomplete_expired",
        "unpaid",
      ],
    },
  },
} as const
