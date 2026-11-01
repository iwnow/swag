import {
  Email,
  InvitationAcceptRequest,
  RegistrationConfirmRequest,
  type ManagedUser,
} from '@swag/contracts';
import type { ZodError } from 'zod';
import type { UserAction } from './access-ui.ts';
import type { FormIssue } from './index.ts';

// Спека 014, 4.6: тексты интерфейса входа, регистрации и приглашения; проверки форм (4.2).

const UNKNOWN_ERROR_TEXT = 'Что-то пошло не так. Попробуйте ещё раз.';

const AUTH_ERROR_TEXT = new Map<string, string>([
  ['invalid_credentials', 'Неверный email или пароль.'],
  ['user_blocked', 'Пользователь заблокирован. Обратитесь к администратору организации.'],
  ['rate_limited', 'Слишком много попыток. Подождите и попробуйте снова.'],
  ['mail_unavailable', 'Не удалось отправить письмо. Попробуйте позже.'],
  ['invalid_token', 'Ссылка недействительна или устарела.'],
  ['email_taken', 'Этот email уже зарегистрирован. Войдите по своему паролю.'],
  ['validation_error', 'Проверьте поля формы.'],
  ['forbidden', 'Недостаточно прав.'],
  ['not_found', 'Не найдено.'],
  ['unauthorized', 'Сессия закончилась. Войдите снова.'],
  ['invalid_refresh_token', 'Сессия закончилась. Войдите снова.'],
  ['org_directory_unavailable', 'Сервис временно недоступен. Попробуйте позже.'],
  ['auth_unavailable', 'Сервис временно недоступен. Попробуйте позже.'],
  ['internal_error', UNKNOWN_ERROR_TEXT],
  ['unknown', UNKNOWN_ERROR_TEXT],
]);

export function authErrorText(code: string): string {
  return AUTH_ERROR_TEXT.get(code) ?? UNKNOWN_ERROR_TEXT;
}

export const FORM_TEXT = {
  password: 'Пароль — от 10 до 128 символов.',
  repeat: 'Пароли не совпадают.',
  organizationName: 'Название — от 1 до 200 символов.',
  email: 'Введите email.',
  comment: 'Укажите комментарий.',
} as const;

export const REGISTRATION_SENT_TEXT =
  'Если адрес верный, мы отправили на него письмо со ссылкой. Откройте его, чтобы закончить регистрацию.';

export const INVITATION_INVALID_TEXT =
  'Приглашение недействительно или устарело. Попросите администратора прислать новое.';

export function invitationSentText(email: string): string {
  return `Приглашение отправлено на ${email}.`;
}

export function blockConfirmText(email: string): string {
  return `Заблокировать ${email}? Его сессии завершатся, рои остановятся.`;
}

export const USER_ACTION_LABEL: Record<UserAction, string> = {
  make_admin: 'Сделать администратором',
  make_user: 'Сделать пользователем',
  block: 'Заблокировать',
  unblock: 'Разблокировать',
};

export const USER_ROLE_LABEL: Record<ManagedUser['role'], string> = {
  user: 'Пользователь',
  admin: 'Администратор',
  supervisor: 'Супервизор',
};

const FIELD_TEXT = new Map<string, string>([
  ['token', authErrorText('invalid_token')],
  ['password', FORM_TEXT.password],
  ['repeat', FORM_TEXT.repeat],
  ['organizationName', FORM_TEXT.organizationName],
]);

const CONFIRM_ORDER = ['token', 'password', 'repeat', 'organizationName'];
const INVITE_ORDER = ['token', 'password', 'repeat'];

function failedFields(error: ZodError): Set<string> {
  return new Set(error.issues.map((issue) => String(issue.path[0])));
}

function fieldIssues(failed: ReadonlySet<string>, order: readonly string[]): FormIssue[] {
  return order
    .filter((field) => failed.has(field))
    .map((field) => ({
      path: field,
      message: FIELD_TEXT.get(field) ?? authErrorText('validation_error'),
    }));
}

export function validateEmailForm(input: {
  email: string;
}): { ok: true; email: string } | { ok: false; issues: FormIssue[] } {
  const parsed = Email.safeParse(input.email);
  if (parsed.success) return { ok: true, email: parsed.data };
  return { ok: false, issues: [{ path: 'email', message: FORM_TEXT.email }] };
}

export function validateConfirmForm(input: {
  token: string;
  password: string;
  repeat: string;
  organizationName: string;
}): { ok: true; body: RegistrationConfirmRequest } | { ok: false; issues: FormIssue[] } {
  const parsed = RegistrationConfirmRequest.safeParse({
    token: input.token,
    password: input.password,
    organizationName: input.organizationName,
  });
  const failed = parsed.success ? new Set<string>() : failedFields(parsed.error);
  if (input.repeat !== input.password) failed.add('repeat');
  if (parsed.success && failed.size === 0) return { ok: true, body: parsed.data };
  return { ok: false, issues: fieldIssues(failed, CONFIRM_ORDER) };
}

export function validateInviteForm(input: {
  token: string;
  password: string;
  repeat: string;
}): { ok: true; body: InvitationAcceptRequest } | { ok: false; issues: FormIssue[] } {
  const parsed = InvitationAcceptRequest.safeParse({
    token: input.token,
    password: input.password,
  });
  const failed = parsed.success ? new Set<string>() : failedFields(parsed.error);
  if (input.repeat !== input.password) failed.add('repeat');
  if (parsed.success && failed.size === 0) return { ok: true, body: parsed.data };
  return { ok: false, issues: fieldIssues(failed, INVITE_ORDER) };
}
