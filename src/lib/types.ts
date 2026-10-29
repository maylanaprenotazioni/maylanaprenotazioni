export type Category = 'hair' | 'consultation';
export type PublicGroup = 'uomo' | 'donna' | 'trattamenti' | 'acconciature' | 'consulenze';
export type BookingMode = 'automatic' | 'manual';

export interface PublicSettings {
  business_name: string;
  logo_url: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  address: string | null;
  privacy_url: string | null;
  public_notice: string | null;
  booking_horizon_days: number;
  min_notice_minutes: number;
  online_booking_enabled: boolean;
  booking_buffer_minutes: number;
  whatsapp_number: string | null;
}

export interface Service {
  id: string;
  category: Category;
  public_group: PublicGroup;
  buffer_after_minutes: number;
  name: string;
  description: string | null;
  price_cents: number | null;
  price_from: boolean;
  duration_minutes: number | null;
  booking_mode: BookingMode;
  sort_order: number;
  active?: boolean;
}

export interface PublicStaff {
  id: string;
  display_name: string;
  bio: string | null;
  service_ids: string[];
}

export interface Catalog {
  settings: PublicSettings;
  services: Service[];
  staff: PublicStaff[];
}

export interface TimeOption {
  starts_at: string;
  ends_at: string;
  recommended?: boolean;
  staff: { id: string; name: string }[];
}

export interface BookedAppointment {
  code: string;
  status: 'confirmed';
  starts_at: string;
  ends_at: string;
  staff_name: string;
  service_name: string;
  duration_minutes: number;
  total_price_cents: number | null;
  price_is_estimate: boolean;
}

export interface BundleSummary {
  label: string | null;
  duration_minutes: number;
  buffer_minutes: number;
  total_minutes: number;
  price_cents: number | null;
  price_is_estimate: boolean;
  requires_approval: boolean;
  staff_count: number;
}

// ---- Admin ----
export type AppointmentStatus = 'confirmed' | 'completed' | 'no_show' | 'cancelled';
export type RequestStatus = 'pending' | 'confirmed' | 'rejected' | 'reschedule' | 'cancelled';

export interface Staff {
  id: string;
  display_name: string;
  bio: string | null;
  active: boolean;
  sort_order: number;
}

export interface WorkingHour {
  id: string;
  staff_id: string;
  weekday: number;
  start_time: string;
  end_time: string;
}

export interface TimeOff {
  id: string;
  staff_id: string | null;
  starts_at: string;
  ends_at: string;
  kind: 'ferie' | 'pausa' | 'chiusura' | 'permesso' | 'altro';
  reason: string | null;
}

export interface Customer {
  id: string;
  first_name: string;
  last_name: string;
  full_name: string;
  phone: string;
  email: string | null;
  marketing_consent?: boolean;
  marketing_consent_at?: string | null;
}

export interface ManagedAppointment {
  code: string;
  items: { name: string; duration_minutes: number; price_cents: number | null; price_from: boolean }[];
  duration_minutes: number;
  total_price_cents: number | null;
  price_is_estimate: boolean;
  status: string;
  service_name: string;
  category: Category;
  self_reschedule: boolean;
  starts_at: string;
  ends_at: string;
  staff_name: string;
  first_name: string;
  can_change: boolean;
  change_deadline: string;
  pending_reschedule_request: boolean;
}

export type NotificationStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';

export interface NotificationRow {
  id: string;
  kind: string;
  audience: 'customer' | 'salon';
  status: NotificationStatus;
  attempts: number;
  last_error: string | null;
  recipient: string | null;
  sent_at: string | null;
  created_at: string;
  next_attempt_at: string;
  appointment_id: string | null;
  booking_request_id: string | null;
}

export interface AppointmentRow {
  id: string;
  code: string;
  starts_at: string;
  ends_at: string;
  status: AppointmentStatus;
  source: 'online' | 'admin' | 'request';
  customer_id: string;
  rescheduled_at: string | null;
  cancelled_at: string | null;
  total_price_cents: number | null;
  price_is_estimate: boolean;
  appointment_items?: AppointmentItem[];
  customer_notes: string | null;
  internal_notes: string | null;
  staff_id: string;
  service_id: string;
  customers: Customer | null;
  services: { name: string; category: Category } | null;
  staff: { display_name: string } | null;
}

export interface RequestRow {
  id: string;
  code: string;
  status: RequestStatus;
  preferred_date: string | null;
  preferred_time_window: 'mattina' | 'pomeriggio' | 'indifferente';
  customer_notes: string | null;
  admin_notes: string | null;
  created_at: string;
  service_id: string;
  preferred_staff_id: string | null;
  proposed_starts_at: string | null;
  proposed_staff_id: string | null;
  reschedule_of_appointment_id: string | null;
  booking_request_items?: { position: number; service_id: string; services: { name: string; duration_minutes: number | null } | null }[];
  customers: Customer | null;
  services: { name: string; category: Category; duration_minutes: number | null } | null;
  appointments: { id: string; starts_at: string; status: AppointmentStatus; staff: { display_name: string } | null }[];
}

export interface AppointmentItem {
  service_id: string;
  position: number;
  name: string;
  duration_minutes: number;
  buffer_minutes: number;
  price_cents: number | null;
  price_from: boolean;
}

export interface AdminSettings extends PublicSettings {
  smart_slots_enabled: boolean;
  min_useful_gap_minutes: number;
  max_recommended_slots: number;
  slot_interval_minutes: number;
  notification_email: string | null;
  email_instructions: string | null;
  customer_change_min_hours: number;
  reminder_1_hours: number | null;
  reminder_2_hours: number | null;
}
