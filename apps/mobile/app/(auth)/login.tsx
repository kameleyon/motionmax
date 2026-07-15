import { useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import * as AppleAuthentication from 'expo-apple-authentication';
import { makeRedirectUri } from 'expo-auth-session';
import { supabase } from '../../lib/supabase';
import LOGO from '../../assets/motionmax-logo.webp';

const C = {
  bg: '#0A0E15', card: '#121826', border: '#1F2A3B', text: '#ECF1F1', headline: '#F2F6F6',
  muted: '#8593A2', muted3: '#6E7C8B', teal: '#14C4C9', teal2: '#35D6DB', onTeal: '#04211F', danger: '#FF6B6B',
};
const F = {
  serif: 'Newsreader_400Regular', body: 'InstrumentSans_400Regular',
  medium: 'InstrumentSans_500Medium', semibold: 'InstrumentSans_600SemiBold',
};

WebBrowser.maybeCompleteAuthSession();

export default function LoginScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<null | 'email' | 'google' | 'apple'>(null);
  const [error, setError] = useState<string | null>(null);

  const done = () => router.replace('/');

  async function signInEmail() {
    setError(null);
    if (!email.trim() || !password) { setError('Enter your email and password.'); return; }
    setBusy('email');
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(null);
    if (error) setError(error.message);
    else done();
  }

  async function signInGoogle() {
    setError(null);
    setBusy('google');
    try {
      const redirectTo = makeRedirectUri();
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo, skipBrowserRedirect: true },
      });
      if (error) throw error;
      if (!data?.url) throw new Error('Could not start Google sign-in.');
      const res = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
      if (res.type === 'success' && res.url) {
        const params = new URLSearchParams(res.url.split('#')[1] ?? res.url.split('?')[1] ?? '');
        const access_token = params.get('access_token');
        const refresh_token = params.get('refresh_token');
        if (access_token && refresh_token) {
          const { error: sErr } = await supabase.auth.setSession({ access_token, refresh_token });
          if (sErr) throw sErr;
          done();
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Google sign-in failed.');
    } finally {
      setBusy(null);
    }
  }

  async function signInApple() {
    setError(null);
    setBusy('apple');
    try {
      const cred = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });
      if (!cred.identityToken) throw new Error('No identity token from Apple.');
      const { error } = await supabase.auth.signInWithIdToken({ provider: 'apple', token: cred.identityToken });
      if (error) throw error;
      done();
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      if (code !== 'ERR_REQUEST_CANCELED') setError(e instanceof Error ? e.message : 'Apple sign-in failed.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: C.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.back}>
          <Text style={styles.backText}>← Back</Text>
        </Pressable>

        <View style={styles.brandRow}>
          <Image source={LOGO} style={styles.logo} resizeMode="contain" />
          <Text style={styles.brand}>MotionMax</Text>
        </View>

        <Text style={styles.h1}>Welcome back</Text>
        <Text style={styles.sub}>Sign in to keep creating.</Text>

        {error && <Text style={styles.error}>{error}</Text>}

        <View style={{ gap: 12, marginTop: 22 }}>
          <View>
            <Text style={styles.label}>Email</Text>
            <TextInput
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.com"
              placeholderTextColor={C.muted3}
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              style={styles.input}
            />
          </View>
          <View>
            <Text style={styles.label}>Password</Text>
            <TextInput
              value={password}
              onChangeText={setPassword}
              placeholder="••••••••"
              placeholderTextColor={C.muted3}
              secureTextEntry
              autoComplete="password"
              style={styles.input}
            />
          </View>
        </View>

        <Pressable onPress={signInEmail} disabled={busy !== null} style={({ pressed }) => [styles.primary, pressed && styles.pressed, busy !== null && { opacity: 0.7 }]}>
          {busy === 'email' ? <ActivityIndicator color={C.onTeal} /> : <Text style={styles.primaryText}>Continue →</Text>}
        </Pressable>

        <View style={styles.divider}>
          <View style={styles.line} /><Text style={styles.or}>or</Text><View style={styles.line} />
        </View>

        <Pressable onPress={signInGoogle} disabled={busy !== null} style={({ pressed }) => [styles.oauth, pressed && styles.pressed]}>
          {busy === 'google' ? <ActivityIndicator color={C.text} /> : <Text style={styles.oauthText}>Continue with Google</Text>}
        </Pressable>

        {Platform.OS === 'ios' && (
          <Pressable onPress={signInApple} disabled={busy !== null} style={({ pressed }) => [styles.oauth, pressed && styles.pressed]}>
            {busy === 'apple' ? <ActivityIndicator color={C.text} /> : <Text style={styles.oauthText}> Continue with Apple</Text>}
          </Pressable>
        )}

        <View style={styles.footRow}>
          <Text style={styles.footText}>New to MotionMax? </Text>
          <Pressable onPress={() => router.back()} hitSlop={8}>
            <Text style={styles.footLink}>Start free</Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 64, paddingBottom: 40, justifyContent: 'center' },
  pressed: { opacity: 0.9, transform: [{ scale: 0.98 }] },
  back: { position: 'absolute', top: 56, left: 20 },
  backText: { fontFamily: F.medium, fontSize: 15, color: C.muted },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  logo: { width: 36, height: 36 },
  brand: { fontFamily: F.semibold, fontSize: 19, letterSpacing: -0.4, color: C.text },
  h1: { fontFamily: F.serif, fontSize: 34, letterSpacing: -0.6, color: C.headline, marginTop: 26 },
  sub: { fontFamily: F.body, fontSize: 15.5, color: C.muted, marginTop: 8 },
  error: { fontFamily: F.medium, fontSize: 13.5, color: C.danger, marginTop: 16 },
  label: { fontFamily: F.medium, fontSize: 13, color: C.muted, marginBottom: 7 },
  input: {
    fontFamily: F.body, fontSize: 16, color: C.text, paddingHorizontal: 15, paddingVertical: 14,
    backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 13,
  },
  primary: {
    marginTop: 20, padding: 16, backgroundColor: C.teal, borderRadius: 14, alignItems: 'center',
    shadowColor: '#0FA7A3', shadowOpacity: 0.5, shadowRadius: 22, shadowOffset: { width: 0, height: 12 }, elevation: 6,
  },
  primaryText: { fontFamily: F.semibold, fontSize: 16, color: C.onTeal },
  divider: { flexDirection: 'row', alignItems: 'center', gap: 12, marginVertical: 22 },
  line: { flex: 1, height: 1, backgroundColor: C.border },
  or: { fontFamily: F.body, fontSize: 13, color: C.muted3 },
  oauth: {
    padding: 15, backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 14,
    alignItems: 'center', marginBottom: 10,
  },
  oauthText: { fontFamily: F.semibold, fontSize: 15.5, color: C.text },
  footRow: { flexDirection: 'row', justifyContent: 'center', marginTop: 20 },
  footText: { fontFamily: F.body, fontSize: 14, color: C.muted },
  footLink: { fontFamily: F.semibold, fontSize: 14, color: C.teal2 },
});
