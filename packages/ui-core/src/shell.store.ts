import { signal, type ReadonlySignal } from '@preact/signals-core';
import type { AuthResult } from './auth-session.ts';
import {
  authErrorText,
  INVITATION_INVALID_TEXT,
  validateConfirmForm,
  validateEmailForm,
  validateInviteForm,
} from './auth-forms.ts';
import { safeReturnTo } from './access-ui.ts';
import type { SessionUserStore } from './session-user.store.ts';
import type { Preferences } from './ports.ts';
import type { FormIssue } from './index.ts';

// Спека 014, 4.12 (REQ-014-5…8, REQ-014-16): стор каркаса — вход, регистрация, подтверждение, приглашение, тема.

export type ThemeMode = 'system' | 'light' | 'dark';

const THEME_KEY = 'swag.theme';
const THEME_MODES: readonly ThemeMode[] = ['system', 'light', 'dark'];

export interface ShellForm {
  busy: boolean;
  error: string | null;
  // Отказ invalid_token на подтверждении или приглашении: страница предлагает регистрацию заново (отклонение от 4.12, D-152).
  invalidToken: boolean;
  issues: FormIssue[];
  sent: boolean;
}

export interface ShellStore {
  readonly form: ReadonlySignal<ShellForm>;
  readonly theme: ReadonlySignal<ThemeMode>;
  readonly sectionUnavailable: ReadonlySignal<boolean>;
  login(email: string, password: string, returnTo: string | null): Promise<string | null>;
  register(email: string): Promise<void>;
  confirmRegistration(input: Parameters<typeof validateConfirmForm>[0]): Promise<string | null>;
  acceptInvitation(input: Parameters<typeof validateInviteForm>[0]): Promise<string | null>;
  logout(): Promise<void>;
  setTheme(mode: ThemeMode): void;
  setSectionUnavailable(flag: boolean): void;
  resetForm(): void;
}

const initialForm = (): ShellForm => ({
  busy: false,
  error: null,
  invalidToken: false,
  issues: [],
  sent: false,
});

export function createShellStore({
  session,
  preferences,
}: {
  session: Pick<
    SessionUserStore,
    'login' | 'register' | 'confirmRegistration' | 'acceptInvitation' | 'logout'
  >;
  preferences: Preferences;
}): ShellStore {
  const form = signal<ShellForm>(initialForm());
  const storedTheme = preferences.get(THEME_KEY);
  const theme = signal<ThemeMode>(THEME_MODES.find((mode) => mode === storedTheme) ?? 'system');
  const sectionUnavailable = signal(false);

  const patch = (change: Partial<ShellForm>): void => {
    form.value = { ...form.value, ...change };
  };
  const clearErrors = (): void => patch({ error: null, invalidToken: false, issues: [] });

  // Проверка формы не прошла, запроса нет. Токен не прошёл схему (например, длиннее 200) — отказ invalid_token, как от сервера; остальные issues не показываем.
  const formRejected = (issues: FormIssue[], invalidTokenText: string): void => {
    if (issues.some((issue) => issue.path === 'token')) {
      patch({ error: invalidTokenText, invalidToken: true, issues: [] });
    } else {
      patch({ issues });
    }
  };

  // Запрос с busy; возвращает код отказа или null при успехе; исключение — код 'unknown'; busy сбрасывается всегда.
  async function attempt(request: () => Promise<AuthResult>): Promise<string | null> {
    patch({ busy: true });
    try {
      const result = await request();
      return result.ok ? null : result.code;
    } catch {
      return 'unknown';
    } finally {
      patch({ busy: false });
    }
  }

  return {
    form,
    theme,
    sectionUnavailable,

    async login(email, password, returnTo) {
      clearErrors();
      const failure = await attempt(() => session.login(email, password));
      if (failure === null) return safeReturnTo(returnTo);
      patch({ error: authErrorText(failure) });
      return null;
    },

    async register(email) {
      clearErrors();
      const checked = validateEmailForm({ email });
      if (!checked.ok) {
        patch({ issues: checked.issues });
        return;
      }
      const failure = await attempt(() => session.register(checked.email));
      if (failure === null) patch({ sent: true });
      else patch({ error: authErrorText(failure) });
    },

    async confirmRegistration(input) {
      clearErrors();
      const checked = validateConfirmForm(input);
      if (!checked.ok) {
        formRejected(checked.issues, authErrorText('invalid_token'));
        return null;
      }
      const failure = await attempt(() => session.confirmRegistration(checked.body));
      if (failure === null) return '/';
      patch({ error: authErrorText(failure), invalidToken: failure === 'invalid_token' });
      return null;
    },

    async acceptInvitation(input) {
      clearErrors();
      const checked = validateInviteForm(input);
      if (!checked.ok) {
        formRejected(checked.issues, INVITATION_INVALID_TEXT);
        return null;
      }
      const failure = await attempt(() => session.acceptInvitation(checked.body));
      if (failure === null) return '/';
      patch({
        error: failure === 'invalid_token' ? INVITATION_INVALID_TEXT : authErrorText(failure),
        invalidToken: failure === 'invalid_token',
      });
      return null;
    },

    async logout() {
      clearErrors();
      await session.logout();
    },

    setTheme(mode) {
      theme.value = mode;
      preferences.set(THEME_KEY, mode);
    },

    setSectionUnavailable(flag) {
      sectionUnavailable.value = flag;
    },

    resetForm() {
      form.value = initialForm();
    },
  };
}
