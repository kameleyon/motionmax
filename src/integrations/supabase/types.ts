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
          admin_id: string
          created_at: string
          details: Json | null
          id: string
          ip_address: string | null
          target_id: string | null
          target_type: string
          user_agent: string | null
        }
        Insert: {
          action: string
          admin_id: string
          created_at?: string
          details?: Json | null
          id?: string
          ip_address?: string | null
          target_id?: string | null
          target_type: string
          user_agent?: string | null
        }
        Update: {
          action?: string
          admin_id?: string
          created_at?: string
          details?: Json | null
          id?: string
          ip_address?: string | null
          target_id?: string | null
          target_type?: string
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
          user_id: string
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
          user_id: string
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
          stripe_payment_intent_id: string | null
          transaction_type: string
          user_id: string
        }
        Insert: {
          amount: number
          created_at?: string
          description?: string | null
          id?: string
          stripe_payment_intent_id?: string | null
          transaction_type: string
          user_id: string
        }
        Update: {
          amount?: number
          created_at?: string
          description?: string | null
          id?: string
          stripe_payment_intent_id?: string | null
          transaction_type?: string
          user_id?: string
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
          user_id: string
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
          user_id: string
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
          user_id?: string
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
          user_id: string
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
          user_id: string
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
          user_id?: string
        }
        Relationships: []
      }
      generations: {
        Row: {
          audio_url: string | null
          completed_at: string | null
          created_at: string
          error_message: string | null
          id: string
          progress: number
          project_id: string
          scenes: Json | null
          script: string | null
          started_at: string | null
          status: string
          user_id: string
          video_url: string | null
        }
        Insert: {
          audio_url?: string | null
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          progress?: number
          project_id: string
          scenes?: Json | null
          script?: string | null
          started_at?: string | null
          status?: string
          user_id: string
          video_url?: string | null
        }
        Update: {
          audio_url?: string | null
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          progress?: number
          project_id?: string
          scenes?: Json | null
          script?: string | null
          started_at?: string | null
          status?: string
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
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          display_name: string | null
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
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
        Relationships: []
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
          content: string
          created_at: string
          description: string | null
          disable_expressions: boolean
          format: string
          id: string
          inspiration_style: string | null
          is_favorite: boolean
          length: string
          presenter_focus: string | null
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
          content: string
          created_at?: string
          description?: string | null
          disable_expressions?: boolean
          format?: string
          id?: string
          inspiration_style?: string | null
          is_favorite?: boolean
          length?: string
          presenter_focus?: string | null
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
          content?: string
          created_at?: string
          description?: string | null
          disable_expressions?: boolean
          format?: string
          id?: string
          inspiration_style?: string | null
          is_favorite?: boolean
          length?: string
          presenter_focus?: string | null
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
      subscriptions: {
        Row: {
          cancel_at_period_end: boolean | null
          created_at: string
          current_period_end: string | null
          current_period_start: string | null
          id: string
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
          id: string
          total_purchased: number
          total_used: number
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          credits_balance?: number
          id?: string
          total_purchased?: number
          total_used?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          credits_balance?: number
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
          flagged_by: string
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
          flagged_by: string
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
          flagged_by?: string
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
          sample_url: string
          user_id: string
          voice_id: string
          voice_name: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          sample_url: string
          user_id: string
          voice_id: string
          voice_name: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          sample_url?: string
          user_id?: string
          voice_id?: string
          voice_name?: string
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
      [_ in never]: never
    }
    Functions: {
      deduct_credits_securely: {
        Args: {
          p_amount: number
          p_description: string
          p_transaction_type: string
          p_user_id: string
        }
        Returns: boolean
      }
      get_shared_project: { Args: { share_token_param: string }; Returns: Json }
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
      update_scene_at_index: {
        Args: {
          p_generation_id: string
          p_progress?: number
          p_scene_data: Json
          p_scene_index: number
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
