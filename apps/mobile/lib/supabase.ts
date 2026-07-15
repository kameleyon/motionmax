import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

// Set these in apps/mobile/.env (EXPO_PUBLIC_ vars are inlined at build time):
//   EXPO_PUBLIC_SUPABASE_URL=https://ayjbvcikuwknqdrpsdmj.supabase.co
//   EXPO_PUBLIC_SUPABASE_ANON_KEY=<anon key>
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? 'https://ayjbvcikuwknqdrpsdmj.supabase.co';
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
