export interface CompanyInfo {
  id: string;
  name: string;
  code: string;
}

export interface UserProfile {
  id: string;
  email: string;
  full_name: string;
  username?: string | null;
  employee_code?: string | null;
  department?: string | null;
  phone?: string | null;
  company_id?: string | null;
  company?: CompanyInfo | null;
  allowed_systems?: string[] | null;
}
