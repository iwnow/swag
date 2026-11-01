import { describe, expect, it } from 'vitest';
import { InvitationAcceptRequest, RegistrationConfirmRequest } from '@swag/contracts';
import {
  authErrorText,
  blockConfirmText,
  invitationSentText,
  validateConfirmForm,
  validateEmailForm,
  validateInviteForm,
  INVITATION_INVALID_TEXT,
  REGISTRATION_SENT_TEXT,
  USER_ACTION_LABEL,
} from '../src/index.ts';

const DEFAULT_ERROR = 'Что-то пошло не так. Попробуйте ещё раз.';
const PASSWORD_TEXT = 'Пароль — от 10 до 128 символов.';
const REPEAT_TEXT = 'Пароли не совпадают.';
const ORG_TEXT = 'Название — от 1 до 200 символов.';
const TOKEN_TEXT = 'Ссылка недействительна или устарела.';

const good = {
  token: 'token-from-mail',
  password: 'correct-horse',
  repeat: 'correct-horse',
  organizationName: 'Организация',
};

describe('auth forms', () => {
  it('AC-014-4: authErrorText даёт тексты таблицы 4.6 и текст по умолчанию', () => {
    const table: Record<string, string> = {
      invalid_credentials: 'Неверный email или пароль.',
      user_blocked: 'Пользователь заблокирован. Обратитесь к администратору организации.',
      rate_limited: 'Слишком много попыток. Подождите и попробуйте снова.',
      mail_unavailable: 'Не удалось отправить письмо. Попробуйте позже.',
      invalid_token: TOKEN_TEXT,
      email_taken: 'Этот email уже зарегистрирован. Войдите по своему паролю.',
      validation_error: 'Проверьте поля формы.',
      forbidden: 'Недостаточно прав.',
      not_found: 'Не найдено.',
      unauthorized: 'Сессия закончилась. Войдите снова.',
      invalid_refresh_token: 'Сессия закончилась. Войдите снова.',
      org_directory_unavailable: 'Сервис временно недоступен. Попробуйте позже.',
      auth_unavailable: 'Сервис временно недоступен. Попробуйте позже.',
      internal_error: DEFAULT_ERROR,
      unknown: DEFAULT_ERROR,
    };
    for (const [code, text] of Object.entries(table)) expect(authErrorText(code)).toBe(text);
    expect(authErrorText('nonexistent')).toBe(DEFAULT_ERROR);
    expect(authErrorText('constructor')).toBe(DEFAULT_ERROR);
  });

  it('AC-014-4: тексты сообщений и подписей из 4.6', () => {
    expect(REGISTRATION_SENT_TEXT).toBe(
      'Если адрес верный, мы отправили на него письмо со ссылкой. Откройте его, чтобы закончить регистрацию.',
    );
    expect(INVITATION_INVALID_TEXT).toBe(
      'Приглашение недействительно или устарело. Попросите администратора прислать новое.',
    );
    expect(invitationSentText('a@b.example')).toBe('Приглашение отправлено на a@b.example.');
    expect(blockConfirmText('a@b.example')).toBe(
      'Заблокировать a@b.example? Его сессии завершатся, рои остановятся.',
    );
    expect(USER_ACTION_LABEL).toEqual({
      make_admin: 'Сделать администратором',
      make_user: 'Сделать пользователем',
      block: 'Заблокировать',
      unblock: 'Разблокировать',
    });
  });

  it('AC-014-7: validateConfirmForm — пароль из 9 символов даёт ошибку password', () => {
    const result = validateConfirmForm({ ...good, password: '123456789', repeat: '123456789' });
    expect(result).toEqual({ ok: false, issues: [{ path: 'password', message: PASSWORD_TEXT }] });
  });

  it('AC-014-7: validateConfirmForm — верный пароль и другой повтор дают ошибку repeat', () => {
    const result = validateConfirmForm({ ...good, repeat: 'other-horse' });
    expect(result).toEqual({ ok: false, issues: [{ path: 'repeat', message: REPEAT_TEXT }] });
  });

  it('AC-014-7: validateConfirmForm — пустое название даёт ошибку organizationName', () => {
    const result = validateConfirmForm({ ...good, organizationName: '   ' });
    expect(result).toEqual({
      ok: false,
      issues: [{ path: 'organizationName', message: ORG_TEXT }],
    });
  });

  it('AC-014-7: validateConfirmForm — все три ошибки идут в порядке password, repeat, organizationName', () => {
    const result = validateConfirmForm({
      ...good,
      password: '123456789',
      repeat: 'other',
      organizationName: '',
    });
    expect(result).toEqual({
      ok: false,
      issues: [
        { path: 'password', message: PASSWORD_TEXT },
        { path: 'repeat', message: REPEAT_TEXT },
        { path: 'organizationName', message: ORG_TEXT },
      ],
    });
  });

  it('AC-014-7: validateConfirmForm — верные данные дают ok и тело по схеме контракта', () => {
    const result = validateConfirmForm(good);
    expect(result).toEqual({
      ok: true,
      body: {
        token: 'token-from-mail',
        password: 'correct-horse',
        organizationName: 'Организация',
      },
    });
    if (result.ok) expect(RegistrationConfirmRequest.safeParse(result.body).success).toBe(true);
  });

  it('AC-014-7: validateConfirmForm — пустой token даёт ошибку token с текстом invalid_token', () => {
    const result = validateConfirmForm({ ...good, token: '' });
    expect(result).toEqual({ ok: false, issues: [{ path: 'token', message: TOKEN_TEXT }] });
  });

  it('AC-014-7: validateInviteForm — пароль, повтор и token; верные данные дают тело по схеме', () => {
    const short = validateInviteForm({ token: 't', password: '123456789', repeat: '123456789' });
    expect(short).toEqual({ ok: false, issues: [{ path: 'password', message: PASSWORD_TEXT }] });

    const mismatch = validateInviteForm({ token: 't', password: 'correct-horse', repeat: 'other' });
    expect(mismatch).toEqual({ ok: false, issues: [{ path: 'repeat', message: REPEAT_TEXT }] });

    const empty = validateInviteForm({
      token: '',
      password: 'correct-horse',
      repeat: 'correct-horse',
    });
    expect(empty).toEqual({ ok: false, issues: [{ path: 'token', message: TOKEN_TEXT }] });

    const result = validateInviteForm({
      token: 't',
      password: 'correct-horse',
      repeat: 'correct-horse',
    });
    expect(result).toEqual({ ok: true, body: { token: 't', password: 'correct-horse' } });
    if (result.ok) expect(InvitationAcceptRequest.safeParse(result.body).success).toBe(true);
  });

  it('AC-014-7: token длиннее 200 символов даёт ошибку token в обеих формах', () => {
    const longToken = 'x'.repeat(201);
    expect(validateConfirmForm({ ...good, token: longToken })).toEqual({
      ok: false,
      issues: [{ path: 'token', message: TOKEN_TEXT }],
    });
    expect(
      validateInviteForm({ token: longToken, password: 'correct-horse', repeat: 'correct-horse' }),
    ).toEqual({ ok: false, issues: [{ path: 'token', message: TOKEN_TEXT }] });
  });

  it('AC-014-7: validateInviteForm — ошибки token, password, repeat идут в этом порядке', () => {
    const result = validateInviteForm({ token: '', password: '123456789', repeat: 'other' });
    expect(result).toEqual({
      ok: false,
      issues: [
        { path: 'token', message: TOKEN_TEXT },
        { path: 'password', message: PASSWORD_TEXT },
        { path: 'repeat', message: REPEAT_TEXT },
      ],
    });
  });

  it('AC-014-7: validateEmailForm — a@b не проходит, ` A@B.example ` даёт a@b.example', () => {
    expect(validateEmailForm({ email: 'a@b' })).toEqual({
      ok: false,
      issues: [{ path: 'email', message: 'Введите email.' }],
    });
    expect(validateEmailForm({ email: ' A@B.example ' })).toEqual({
      ok: true,
      email: 'a@b.example',
    });
  });
});
