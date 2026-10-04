import AsyncStorage from '@react-native-async-storage/async-storage';
import { getSupabaseClient, resetSupabaseClient } from './supabase';
import { UserProfile, CompanyInfo } from '../types/auth';

const STORAGE_KEY_PROFILE = 'auth_user_profile';

export async function resolveEmailFromInput(input: string, client: any): Promise<string> {
  const cleanInput = input.trim();
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanInput);
  if (isEmail) return cleanInput;

  // Check if input is prefix.username (e.g. ctg.phuc)
  const prefixMatch = cleanInput.match(/^([a-z0-9]+)\.([a-z0-9_.-]+)$/i);
  if (prefixMatch) {
    return `${cleanInput}@system.local`;
  }

  // Try RPC get_user_email_by_username
  try {
    const { data: userEmail, error } = await client.rpc('get_user_email_by_username', {
      p_username: cleanInput
    });
    if (!error && userEmail) {
      return userEmail;
    }
  } catch (err) {
    // Fallback if RPC fails
  }

  // Last attempt: query user_profiles directly
  try {
    const { data: found } = await client
      .from('user_profiles')
      .select('email')
      .ilike('username', cleanInput)
      .maybeSingle();

    if (found?.email) {
      return found.email;
    }
  } catch (err) {
    // ignore
  }

  return cleanInput;
}

export async function fetchUserProfile(userId: string, client: any): Promise<UserProfile | null> {
  try {
    const { data, error } = await client
      .from('user_profiles')
      .select(`
        id,
        email,
        full_name,
        username,
        employee_code,
        department,
        phone,
        company_id,
        allowed_systems,
        companies ( id, name, code )
      `)
      .eq('id', userId)
      .maybeSingle();

    if (error || !data) return null;

    const companyData = data.companies as any;
    let company: CompanyInfo | null = companyData ? {
      id: companyData.id,
      name: companyData.name,
      code: companyData.code
    } : null;

    if (!company && data.company_id) {
      try {
        const { data: comp } = await client
          .from('companies')
          .select('id, name, code')
          .eq('id', data.company_id)
          .maybeSingle();
        if (comp) {
          company = comp;
        } else if (data.company_id === 'b503014d-19b6-464e-91f3-f34eba4b4b05') {
          company = {
            id: data.company_id,
            name: 'Công Ty Cổ Phần Tập Đoàn XNK Trái Cây Chánh Thu',
            code: 'CTG'
          };
        }
      } catch {}
    }

    const profile: UserProfile = {
      id: data.id,
      email: data.email,
      full_name: data.full_name || 'Nhân viên',
      username: data.username,
      employee_code: data.employee_code,
      department: data.department,
      phone: data.phone,
      company_id: data.company_id,
      company,
      allowed_systems: data.allowed_systems
    };

    await AsyncStorage.setItem(STORAGE_KEY_PROFILE, JSON.stringify(profile));
    return profile;
  } catch (err) {
    console.error('Lỗi lấy thông tin người dùng:', err);
    return null;
  }
}

export async function loginUser(
  usernameOrEmail: string,
  pass: string
): Promise<{ success: boolean; user?: UserProfile; message?: string }> {
  try {
    const client = await getSupabaseClient();
    const resolvedEmail = await resolveEmailFromInput(usernameOrEmail, client);

    const { data: authData, error: authErr } = await client.auth.signInWithPassword({
      email: resolvedEmail,
      password: pass
    });

    if (authErr) {
      if (authErr.message.includes('Invalid login credentials')) {
        return { success: false, message: 'Sai tên đăng nhập hoặc mật khẩu' };
      }
      return { success: false, message: authErr.message };
    }

    if (!authData.user) {
      return { success: false, message: 'Không thể xác thực tài khoản' };
    }

    const profile = await fetchUserProfile(authData.user.id, client);
    if (!profile) {
      // Fallback profile if user_profiles row isn't yet created
      const fallback: UserProfile = {
        id: authData.user.id,
        email: authData.user.email || resolvedEmail,
        full_name: authData.user.user_metadata?.full_name || authData.user.email || 'Nhân viên',
      };
      await AsyncStorage.setItem(STORAGE_KEY_PROFILE, JSON.stringify(fallback));
      return { success: true, user: fallback };
    }

    return { success: true, user: profile };
  } catch (err: any) {
    return { success: false, message: err.message || 'Lỗi kết nối máy chủ' };
  }
}

export async function logoutUser(): Promise<void> {
  try {
    const client = await getSupabaseClient();
    await client.auth.signOut();
  } catch (err) {
    console.warn('Lỗi đăng xuất:', err);
  } finally {
    await AsyncStorage.removeItem(STORAGE_KEY_PROFILE);
    resetSupabaseClient();
  }
}

export async function getStoredUser(): Promise<UserProfile | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY_PROFILE);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function checkSessionUser(): Promise<UserProfile | null> {
  try {
    const client = await getSupabaseClient();
    const { data: { session } } = await client.auth.getSession();

    if (!session?.user) {
      // If no valid cloud session, also clear stored profile
      await AsyncStorage.removeItem(STORAGE_KEY_PROFILE);
      return null;
    }

    // Try to get fresh profile from cloud
    const profile = await fetchUserProfile(session.user.id, client);
    if (profile) return profile;

    // Fallback to locally stored profile
    return await getStoredUser();
  } catch (err) {
    // Offline mode: allow using cached profile if session was previously established
    return await getStoredUser();
  }
}
