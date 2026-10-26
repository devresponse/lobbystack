import { intlLocale, normalizeInterfaceLocale, withoutCardAndIdNumbers, type BrandImage, type InterfaceLocale } from "@lobbystack/shared";

export type TemplateName = "existing_account" | "account_setup" | "verify_email" | "password_reset" | "invitation" | "operator_alert" | "feedback_submission" | "onboarding_followup" | "promo_ending" | "call_transcript";

type Link = { label: string; url: string };

/** One turn of a call as an email shows it: the time from the call's start, who spoke and what they said. */
type TranscriptLine = { at: string; speaker: string; text: string };

type Block =
  | { kind: "paragraph"; text: string; link?: Link | undefined }
  | { kind: "button"; label: string; url: string }
  | { kind: "code"; code: string }
  | { kind: "quote"; text: string }
  | { kind: "facts"; rows: Array<{ label: string; value: string }> }
  | { kind: "transcript"; title: string; lines: TranscriptLine[] };

/**
 * An email laid out once and written out twice: as plain text with a blank
 * line between parts, and as HTML. Every email ends with why the reader got it.
 */
type EmailContent = { locale: InterfaceLocale; eyebrow?: string | undefined; heading: string; blocks: Block[]; reason?: { text: string; link?: Link | undefined } | undefined };

export type RenderEmailInput = {
  template: TemplateName;
  subject: string;
  /** The recipient, whom the email names when it says why they got it. */
  to: string;
  variables: Record<string, string>;
  /** The deployment's name, which the email calls the app by (see docs/branding.md). */
  appName: string;
  logo?: BrandImage | undefined;
  /** The call a call_transcript email is about. */
  callTranscript?: CallTranscriptEmail | undefined;
};

/** The plain text every email has, the HTML that all but the personal and internal ones add, and the files a long call's email carries. */
export function renderEmail(input: RenderEmailInput): { text: string; html?: string; attachments?: EmailAttachment[] } {
  if (input.template === "onboarding_followup") return { text: onboardingFollowupBody(input.variables, input.appName) };
  if (input.template === "feedback_submission") return { text: feedbackBody(input.variables, input.appName) };
  if (input.template === "call_transcript") {
    if (!input.callTranscript) throw new Error("A call_transcript email needs its call.");
    const { content, attachment } = callTranscript(input.appName, input.callTranscript);
    return { text: renderText(content), html: renderHtml(content, { appName: input.appName, logo: input.logo, title: input.subject, styles: TRANSCRIPT_STYLES }), ...(attachment ? { attachments: [attachment] } : {}) };
  }
  const content = emailContent(input);
  return { text: renderText(content), html: renderHtml(content, { appName: input.appName, logo: input.logo, title: input.subject }) };
}

function emailContent(input: RenderEmailInput): EmailContent {
  const { variables } = input;
  const locale = normalizeInterfaceLocale(variables.locale) ?? "en";
  const context = { app: input.appName, email: input.to, locale };
  switch (input.template) {
    case "existing_account":
      return existingAccount(context, variables);
    case "account_setup":
      return accountSetup({ ...context, email: variables.email || input.to }, variables);
    case "verify_email":
      if (variables.code) return verificationCode(context, variables.code);
      return variables.purpose === "email_change" ? emailChange(context, variables) : newEmailAddress(context, variables);
    case "password_reset":
      return variables.code ? passwordResetCode(context, variables.code) : passwordResetLink(context, variables);
    case "invitation":
      return invitation(context, variables);
    case "promo_ending":
      return promoEnding(context, variables);
    default:
      return operatorAlert({ app: input.appName, heading: input.subject }, variables);
  }
}

type Context = { app: string; email: string; locale: InterfaceLocale };

const CODE_EXPIRY: Record<InterfaceLocale, string> = {
  en: "The code works for 10 minutes. After that, you can ask for a new one on the same page.",
  fr: "Ce code est valide pendant 10 minutes. Ensuite, vous pouvez en demander un nouveau sur la même page.",
  es: "El código es válido durante 10 minutos. Después, puede pedir uno nuevo en la misma página.",
  sr: "Kod važi 10 minuta. Posle toga možete da zatražite novi na istoj stranici.",
};

const LINK_EXPIRY: Record<InterfaceLocale, string> = {
  en: "The link expires in 1 hour.",
  fr: "Ce lien expire dans 1 heure.",
  es: "El enlace caduca en 1 hora.",
  sr: "Link ističe za 1 sat.",
};

// French puts no "de" before the app's name and Serbian never declines it,
// because a configured name can't change its form (see docs/branding.md).

function existingAccount({ app, email, locale }: Context, variables: Record<string, string>): EmailContent {
  const copy = {
    en: {
      heading: "You already have an account",
      intro: `Someone, probably you, tried to create a new ${app} account with ${email}. This address already has an account, so we didn't create another one.`,
      signIn: `Sign in to ${app}`,
      forgot: "Forgot your password?",
      reset: "Choose a new one",
      reason: `You're receiving this email because ${email} was entered on the ${app} sign-up page. If that wasn't you, you can ignore this email. Your account hasn't changed.`,
    },
    fr: {
      heading: "Vous avez déjà un compte",
      intro: `Quelqu'un, probablement vous, a essayé de créer un nouveau compte ${app} avec ${email}. Cette adresse a déjà un compte, alors nous n'en avons pas créé d'autre.`,
      signIn: `Se connecter à ${app}`,
      forgot: "Mot de passe oublié?",
      reset: "Choisissez-en un nouveau",
      reason: `Vous recevez ce courriel parce que l'adresse ${email} a été saisie sur la page d'inscription du service ${app}. Si ce n'était pas vous, vous pouvez ignorer ce courriel. Votre compte n'a pas changé.`,
    },
    es: {
      heading: "Ya tiene una cuenta",
      intro: `Alguien, probablemente usted, intentó crear una nueva cuenta de ${app} con ${email}. Esta dirección ya tiene una cuenta, así que no creamos otra.`,
      signIn: `Iniciar sesión en ${app}`,
      forgot: "¿Olvidó su contraseña?",
      reset: "Elija una nueva",
      reason: `Recibe este correo porque se introdujo la dirección ${email} en la página de registro de ${app}. Si no fue usted, puede ignorar este correo. Su cuenta no ha cambiado.`,
    },
    sr: {
      heading: "Već imate nalog",
      intro: `Neko, verovatno Vi, pokušao je da napravi novi ${app} nalog sa adresom ${email}. Za ovu adresu već postoji nalog, pa nismo napravili novi.`,
      signIn: `Prijavite se na svoj ${app} nalog`,
      forgot: "Zaboravili ste lozinku?",
      reset: "Izaberite novu",
      reason: `Ovaj imejl ste dobili jer je adresa ${email} uneta na stranici za registraciju na servisu ${app}. Ako to niste bili Vi, možete da zanemarite ovaj imejl. Vaš nalog se nije promenio.`,
    },
  }[locale];
  return {
    locale,
    heading: copy.heading,
    blocks: [
      { kind: "paragraph", text: copy.intro },
      { kind: "button", label: copy.signIn, url: variables.signInUrl ?? "" },
      { kind: "paragraph", text: copy.forgot, link: { label: copy.reset, url: variables.resetUrl ?? "" } },
    ],
    reason: { text: copy.reason },
  };
}

/** For an account a platform key made: the forgot-password page's code sets its first password and verifies the email. */
function accountSetup({ app, email, locale }: Context, variables: Record<string, string>): EmailContent {
  const copy = {
    en: {
      heading: `Your ${app} account is ready`,
      intro: `An account on ${app} was created for you with ${email}. To start using it, choose a password.`,
      button: "Choose a password",
      steps: `On that page, enter ${email}. We'll email you a code to type in, and then you can choose your password.`,
      reason: `You're receiving this email because a partner of ${app} created this account for ${email}. If you weren't expecting it, you can ignore this email.`,
    },
    fr: {
      heading: `Votre compte ${app} est prêt`,
      intro: `Un compte ${app} a été créé pour vous avec l'adresse ${email}. Pour commencer à l'utiliser, choisissez un mot de passe.`,
      button: "Choisir un mot de passe",
      steps: `Sur cette page, entrez ${email}. Nous vous enverrons par courriel un code à saisir, puis vous pourrez choisir votre mot de passe.`,
      reason: `Vous recevez ce courriel parce qu'un partenaire du service ${app} a créé ce compte pour ${email}. Si vous ne l'attendiez pas, vous pouvez ignorer ce courriel.`,
    },
    es: {
      heading: `Su cuenta de ${app} está lista`,
      intro: `Se creó una cuenta de ${app} para usted con la dirección ${email}. Para empezar a usarla, elija una contraseña.`,
      button: "Elegir una contraseña",
      steps: `En esa página, escriba ${email}. Le enviaremos por correo un código para introducir y después podrá elegir su contraseña.`,
      reason: `Recibe este correo porque un socio de ${app} creó esta cuenta para ${email}. Si no lo esperaba, puede ignorar este correo.`,
    },
    sr: {
      heading: `Vaš ${app} nalog je spreman`,
      intro: `Za Vas je napravljen ${app} nalog sa adresom ${email}. Da biste počeli da ga koristite, izaberite lozinku.`,
      button: "Izaberite lozinku",
      steps: `Na toj stranici unesite ${email}. Poslaćemo Vam imejlom kod koji treba da unesete, a zatim možete da izaberete lozinku.`,
      reason: `Ovaj imejl ste dobili jer je partner servisa ${app} napravio ovaj nalog za ${email}. Ako ovo niste očekivali, možete da zanemarite ovaj imejl.`,
    },
  }[locale];
  return {
    locale,
    heading: copy.heading,
    blocks: [
      { kind: "paragraph", text: copy.intro },
      { kind: "button", label: copy.button, url: variables.url ?? "" },
      { kind: "paragraph", text: copy.steps },
    ],
    reason: { text: copy.reason },
  };
}

function verificationCode({ app, email, locale }: Context, code: string): EmailContent {
  const copy = {
    en: {
      heading: "Verify your email address",
      intro: `Enter this code to finish setting up your ${app} account.`,
      reason: `You're receiving this email because ${email} was used to sign up for ${app}. If that wasn't you, you can ignore this email.`,
    },
    fr: {
      heading: "Vérifiez votre adresse courriel",
      intro: `Entrez ce code pour terminer la configuration de votre compte ${app}.`,
      reason: `Vous recevez ce courriel parce que l'adresse ${email} a servi à créer un compte ${app}. Si ce n'était pas vous, vous pouvez ignorer ce courriel.`,
    },
    es: {
      heading: "Verifique su dirección de correo",
      intro: `Introduzca este código para terminar de configurar su cuenta de ${app}.`,
      reason: `Recibe este correo porque se usó la dirección ${email} para registrarse en ${app}. Si no fue usted, puede ignorar este correo.`,
    },
    sr: {
      heading: "Potvrdite imejl adresu",
      intro: `Unesite ovaj kod da biste završili podešavanje svog ${app} naloga.`,
      reason: `Ovaj imejl ste dobili jer je adresa ${email} korišćena za registraciju na servisu ${app}. Ako to niste bili Vi, možete da zanemarite ovaj imejl.`,
    },
  }[locale];
  return {
    locale,
    heading: copy.heading,
    blocks: [{ kind: "paragraph", text: copy.intro }, { kind: "code", code }, { kind: "paragraph", text: CODE_EXPIRY[locale] }],
    reason: { text: copy.reason },
  };
}

/** Sent to the address someone is moving their account to, once the current address approved it. */
function newEmailAddress({ app, email, locale }: Context, variables: Record<string, string>): EmailContent {
  const copy = {
    en: {
      heading: "Confirm your new email address",
      intro: `You asked to change the email address of your ${app} account to ${email}. Confirm this address to finish the change.`,
      button: "Confirm email address",
      expiry: "The link expires in 1 hour. Until you confirm, your account keeps its current email address.",
      reason: `You're receiving this email because someone asked to use ${email} for an account on ${app}. If that wasn't you, you can ignore this email and nothing will change.`,
    },
    fr: {
      heading: "Confirmez votre nouvelle adresse courriel",
      intro: `Vous avez demandé à remplacer l'adresse courriel de votre compte ${app} par ${email}. Confirmez cette adresse pour terminer le changement.`,
      button: "Confirmer l'adresse courriel",
      expiry: "Ce lien expire dans 1 heure. D'ici là, votre compte garde son adresse actuelle.",
      reason: `Vous recevez ce courriel parce que quelqu'un a demandé à utiliser ${email} pour un compte ${app}. Si ce n'était pas vous, ignorez ce courriel et rien ne changera.`,
    },
    es: {
      heading: "Confirme su nueva dirección de correo",
      intro: `Pidió cambiar la dirección de correo de su cuenta de ${app} a ${email}. Confirme esta dirección para terminar el cambio.`,
      button: "Confirmar dirección de correo",
      expiry: "El enlace caduca en 1 hora. Hasta que la confirme, su cuenta mantiene su dirección actual.",
      reason: `Recibe este correo porque alguien pidió usar ${email} para una cuenta de ${app}. Si no fue usted, ignore este correo y no cambiará nada.`,
    },
    sr: {
      heading: "Potvrdite novu imejl adresu",
      intro: `Zatražili ste da se imejl adresa Vašeg ${app} naloga promeni u ${email}. Potvrdite ovu adresu da biste završili promenu.`,
      button: "Potvrdi imejl adresu",
      expiry: "Link ističe za 1 sat. Do tada Vaš nalog zadržava trenutnu adresu.",
      reason: `Ovaj imejl ste dobili jer je neko zatražio da se adresa ${email} koristi za nalog na servisu ${app}. Ako to niste bili Vi, zanemarite ovaj imejl i ništa se neće promeniti.`,
    },
  }[locale];
  return {
    locale,
    heading: copy.heading,
    blocks: [{ kind: "paragraph", text: copy.intro }, { kind: "button", label: copy.button, url: variables.url ?? "" }, { kind: "paragraph", text: copy.expiry }],
    reason: { text: copy.reason },
  };
}

/** Sent to the account's current address to approve moving it to `newEmail`. */
function emailChange({ app, email, locale }: Context, variables: Record<string, string>): EmailContent {
  const newEmail = variables.newEmail;
  const copy = {
    en: {
      heading: "Confirm your email change",
      intro: newEmail ? `Someone asked to change the sign-in email of your ${app} account from ${email} to ${newEmail}.` : `Someone asked to change the sign-in email of your ${app} account.`,
      button: "Approve the change",
      next: `After you approve, we'll send a link to ${newEmail || "the new address"} to confirm it. The link in this email expires in 1 hour.`,
      reason: `You're receiving this email because ${email} is the current sign-in email of this ${app} account. If you didn't ask for this change, ignore this email and your address stays the same. We also suggest changing your password.`,
    },
    fr: {
      heading: "Confirmez le changement d'adresse courriel",
      intro: newEmail ? `Quelqu'un a demandé à remplacer l'adresse de connexion de votre compte ${app}, ${email}, par ${newEmail}.` : `Quelqu'un a demandé à changer l'adresse de connexion de votre compte ${app}.`,
      button: "Approuver le changement",
      next: `Après votre approbation, nous enverrons un lien à ${newEmail || "la nouvelle adresse"} pour la confirmer. Le lien de ce courriel expire dans 1 heure.`,
      reason: `Vous recevez ce courriel parce que ${email} est l'adresse de connexion actuelle de ce compte ${app}. Si vous n'avez pas demandé ce changement, ignorez ce courriel et votre adresse restera la même. Nous vous conseillons aussi de changer votre mot de passe.`,
    },
    es: {
      heading: "Confirme el cambio de correo",
      intro: newEmail ? `Alguien pidió cambiar el correo de inicio de sesión de su cuenta de ${app} de ${email} a ${newEmail}.` : `Alguien pidió cambiar el correo de inicio de sesión de su cuenta de ${app}.`,
      button: "Aprobar el cambio",
      next: `Cuando lo apruebe, enviaremos a ${newEmail || "la nueva dirección"} un enlace para confirmarla. El enlace de este correo caduca en 1 hora.`,
      reason: `Recibe este correo porque ${email} es el correo de inicio de sesión actual de esta cuenta de ${app}. Si no pidió este cambio, ignore este correo y su dirección seguirá igual. También le recomendamos cambiar su contraseña.`,
    },
    sr: {
      heading: "Potvrdite promenu imejl adrese",
      intro: newEmail ? `Neko je zatražio da se adresa za prijavu na Vaš ${app} nalog promeni sa ${email} na ${newEmail}.` : `Neko je zatražio da se promeni adresa za prijavu na Vaš ${app} nalog.`,
      button: "Odobri promenu",
      next: `Kada odobrite, poslaćemo link na ${newEmail || "novu adresu"} da bismo je potvrdili. Link u ovom imejlu ističe za 1 sat.`,
      reason: `Ovaj imejl ste dobili jer je ${email} trenutna adresa za prijavu na ovaj ${app} nalog. Ako niste zatražili ovu promenu, zanemarite ovaj imejl i adresa ostaje ista. Preporučujemo i da promenite lozinku.`,
    },
  }[locale];
  return {
    locale,
    heading: copy.heading,
    blocks: [{ kind: "paragraph", text: copy.intro }, { kind: "button", label: copy.button, url: variables.url ?? "" }, { kind: "paragraph", text: copy.next }],
    reason: { text: copy.reason },
  };
}

function passwordResetReason({ app, email, locale }: Context): string {
  return {
    en: `You're receiving this email because someone asked to reset the password of the ${app} account for ${email}. If that wasn't you, you can ignore this email. Your password stays the same.`,
    fr: `Vous recevez ce courriel parce que quelqu'un a demandé à réinitialiser le mot de passe du compte ${app} associé à ${email}. Si ce n'était pas vous, vous pouvez ignorer ce courriel. Votre mot de passe reste le même.`,
    es: `Recibe este correo porque alguien pidió restablecer la contraseña de la cuenta de ${app} asociada a ${email}. Si no fue usted, puede ignorar este correo. Su contraseña no cambiará.`,
    sr: `Ovaj imejl ste dobili jer je neko zatražio resetovanje lozinke za ${app} nalog sa adresom ${email}. Ako to niste bili Vi, možete da zanemarite ovaj imejl. Lozinka ostaje ista.`,
  }[locale];
}

const PASSWORD_RESET_HEADING: Record<InterfaceLocale, string> = {
  en: "Reset your password",
  fr: "Réinitialisez votre mot de passe",
  es: "Restablezca su contraseña",
  sr: "Resetujte lozinku",
};

function passwordResetCode(context: Context, code: string): EmailContent {
  const { app, locale } = context;
  const intro = {
    en: `Enter this code on the ${app} password reset page to choose a new password.`,
    fr: "Entrez ce code sur la page de réinitialisation du mot de passe pour en choisir un nouveau.",
    es: "Introduzca este código en la página para restablecer la contraseña y elija una nueva.",
    sr: "Unesite ovaj kod na stranici za resetovanje lozinke da biste izabrali novu.",
  }[locale];
  return {
    locale,
    heading: PASSWORD_RESET_HEADING[locale],
    blocks: [{ kind: "paragraph", text: intro }, { kind: "code", code }, { kind: "paragraph", text: CODE_EXPIRY[locale] }],
    reason: { text: passwordResetReason(context) },
  };
}

/** The link that Better Auth's link-based reset still sends. */
function passwordResetLink(context: Context, variables: Record<string, string>): EmailContent {
  const { app, locale } = context;
  const copy = {
    en: { intro: `Choose a new password for your ${app} account with the link below.`, button: "Choose a new password" },
    fr: { intro: `Choisissez un nouveau mot de passe pour votre compte ${app} avec le lien ci-dessous.`, button: "Choisir un nouveau mot de passe" },
    es: { intro: `Elija una nueva contraseña para su cuenta de ${app} con el enlace de abajo.`, button: "Elegir una nueva contraseña" },
    sr: { intro: `Izaberite novu lozinku za svoj ${app} nalog preko linka ispod.`, button: "Izaberite novu lozinku" },
  }[locale];
  return {
    locale,
    heading: PASSWORD_RESET_HEADING[locale],
    blocks: [{ kind: "paragraph", text: copy.intro }, { kind: "button", label: copy.button, url: variables.url ?? "" }, { kind: "paragraph", text: LINK_EXPIRY[locale] }],
    reason: { text: passwordResetReason(context) },
  };
}

type InvitationRole = "business_owner" | "business_admin" | "scheduler" | "viewer";

const INVITATION_ROLES: Record<InterfaceLocale, Record<InvitationRole, string>> = {
  en: { business_owner: "as an owner", business_admin: "as an admin", scheduler: "as a scheduler", viewer: "as a viewer" },
  fr: { business_owner: "en tant que propriétaire", business_admin: "en tant qu'administrateur", scheduler: "en tant que planificateur", viewer: "en tant que lecteur" },
  es: { business_owner: "como propietario", business_admin: "como administrador", scheduler: "como planificador", viewer: "como lector" },
  sr: { business_owner: "kao vlasnik", business_admin: "kao administrator", scheduler: "kao planer", viewer: "kao posmatrač" },
};

const SOMEONE_ON_THE_TEAM: Record<InterfaceLocale, string> = {
  en: "Someone on the team",
  fr: "Un membre de l'équipe",
  es: "Un miembro del equipo",
  sr: "Član tima",
};

/** Who sent an invitation: their name and address, or the address alone when the name is just its first part. */
function inviterLabel(variables: Record<string, string>, locale: InterfaceLocale): string {
  const name = variables.inviterName?.trim();
  const email = variables.inviterEmail?.trim();
  if (!email) return name || SOMEONE_ON_THE_TEAM[locale];
  return name && name.toLowerCase() !== email.split("@")[0]?.toLowerCase() ? `${name} (${email})` : email;
}

/** The subject of an invitation, which the worker writes because the invitation is queued without one. */
export function invitationSubject(variables: Record<string, string>, appName: string): string {
  const locale = normalizeInterfaceLocale(variables.locale) ?? "en";
  const business = variables.businessName?.trim();
  const handover = variables.transfersOwnership === "true";
  if (!business) return { en: `You're invited to join ${appName}`, fr: `Invitation à rejoindre ${appName}`, es: `Invitación para unirse a ${appName}`, sr: `Pozivnica za servis ${appName}` }[locale];
  if (handover) return { en: `Take over ${business} on ${appName}`, fr: `Prenez en charge ${business} sur ${appName}`, es: `Asuma la gestión de ${business} en ${appName}`, sr: `Preuzmite firmu ${business} na servisu ${appName}` }[locale];
  return { en: `You're invited to join ${business} on ${appName}`, fr: `Invitation à rejoindre ${business} sur ${appName}`, es: `Invitación para unirse a ${business} en ${appName}`, sr: `Pozivnica za firmu ${business} na servisu ${appName}` }[locale];
}

/**
 * An invitation to a business's team, or a handover of the business itself.
 * Invitations queued before they carried the business and the inviter get
 * the general wording.
 */
function invitation({ app, email, locale }: Context, variables: Record<string, string>): EmailContent {
  const business = variables.businessName?.trim();
  const inviter = inviterLabel(variables, locale);
  const role = INVITATION_ROLES[locale][variables.role as InvitationRole] as string | undefined;
  const as = role ? ` ${role}` : "";
  const handover = variables.transfersOwnership === "true" && Boolean(business);
  const copy = {
    en: {
      heading: handover ? `Take over ${business} on ${app}` : business ? `Join ${business} on ${app}` : `Join ${app}`,
      intro: handover ? `${inviter} wants to hand ${business} over to you on ${app}. When you accept, you become its owner and they leave the team.` : business ? `${inviter} invited you to join ${business} on ${app}${as}.` : `${inviter} invited you to join a team on ${app}.`,
      about: business ? `${business} uses ${app} to answer its calls and messages with an AI receptionist.` : `${app} answers calls and messages with an AI receptionist.`,
      button: "Accept invitation",
      howTo: `To accept, sign in or create an account with ${email}. The invitation expires in 7 days.`,
      reason: `You're receiving this email because ${email} was invited to join ${business || "a team"} on ${app}. If you weren't expecting it, you can ignore this email and the invitation will expire.`,
    },
    fr: {
      heading: handover ? `Prenez en charge ${business} sur ${app}` : business ? `Rejoignez ${business} sur ${app}` : `Rejoignez ${app}`,
      intro: handover ? `${inviter} souhaite vous confier ${business} sur ${app}. En acceptant, vous en devenez propriétaire et cette personne quitte l'équipe.` : business ? `${inviter} vous invite à rejoindre ${business} sur ${app}${as}.` : `${inviter} vous invite à rejoindre une équipe sur ${app}.`,
      about: business ? `${business} utilise ${app} pour répondre à ses appels et à ses messages avec une réceptionniste IA.` : `${app} répond aux appels et aux messages avec une réceptionniste IA.`,
      button: "Accepter l'invitation",
      howTo: `Pour accepter, connectez-vous ou créez un compte avec ${email}. L'invitation expire dans 7 jours.`,
      reason: `Vous recevez ce courriel parce que l'adresse ${email} a été invitée à rejoindre ${business || "une équipe"} sur ${app}. Si vous ne l'attendiez pas, vous pouvez ignorer ce courriel et l'invitation expirera.`,
    },
    es: {
      heading: handover ? `Asuma la gestión de ${business} en ${app}` : business ? `Únase a ${business} en ${app}` : `Únase a ${app}`,
      intro: handover ? `${inviter} quiere transferirle ${business} en ${app}. Al aceptar, usted pasa a ser su propietario y esa persona deja el equipo.` : business ? `${inviter} le invitó a unirse a ${business} en ${app}${as}.` : `${inviter} le invitó a unirse a un equipo en ${app}.`,
      about: business ? `${business} usa ${app} para atender sus llamadas y mensajes con una recepcionista de IA.` : `${app} atiende llamadas y mensajes con una recepcionista de IA.`,
      button: "Aceptar invitación",
      howTo: `Para aceptar, inicie sesión o cree una cuenta con ${email}. La invitación caduca en 7 días.`,
      reason: `Recibe este correo porque se invitó a ${email} a unirse a ${business || "un equipo"} en ${app}. Si no lo esperaba, puede ignorar este correo y la invitación caducará.`,
    },
    sr: {
      heading: handover ? `Preuzmite firmu ${business} na servisu ${app}` : business ? `Pridružite se firmi ${business} na servisu ${app}` : `Pridružite se timu na servisu ${app}`,
      intro: handover ? `${inviter} želi da Vam preda firmu ${business} na servisu ${app}. Kada prihvatite, postajete njen vlasnik, a ta osoba napušta tim.` : business ? `${inviter} Vas poziva da se pridružite firmi ${business} na servisu ${app}${as}.` : `${inviter} Vas poziva da se pridružite timu na servisu ${app}.`,
      about: business ? `Firma ${business} koristi servis ${app}, AI recepcionera koji odgovara na pozive i poruke.` : `Servis ${app} je AI recepcioner koji odgovara na pozive i poruke.`,
      button: "Prihvati pozivnicu",
      howTo: `Da biste prihvatili, prijavite se ili napravite nalog sa adresom ${email}. Pozivnica ističe za 7 dana.`,
      reason: business ? `Ovaj imejl ste dobili jer je adresa ${email} pozvana da se pridruži firmi ${business} na servisu ${app}. Ako ovo niste očekivali, možete da zanemarite ovaj imejl i pozivnica će isteći.` : `Ovaj imejl ste dobili jer je adresa ${email} pozvana da se pridruži timu na servisu ${app}. Ako ovo niste očekivali, možete da zanemarite ovaj imejl i pozivnica će isteći.`,
    },
  }[locale];
  return {
    locale,
    heading: copy.heading,
    blocks: [
      { kind: "paragraph", text: copy.intro },
      { kind: "paragraph", text: copy.about },
      { kind: "button", label: copy.button, url: variables.url ?? "" },
      { kind: "paragraph", text: copy.howTo },
    ],
    reason: { text: copy.reason },
  };
}

/** A date in the reader's language and the business's time zone. Serbian gets digits, since a month's name would need declining. */
function formatDay(iso: string | undefined, locale: InterfaceLocale, timeZone: string | undefined): string {
  const date = new Date(iso ?? "");
  if (Number.isNaN(date.getTime())) return iso ?? "";
  const options: Intl.DateTimeFormatOptions = { dateStyle: locale === "sr" ? "medium" : "long" };
  try {
    return new Intl.DateTimeFormat(intlLocale(locale), { ...options, timeZone: timeZone || "UTC" }).format(date);
  } catch {
    return new Intl.DateTimeFormat(intlLocale(locale), { ...options, timeZone: "UTC" }).format(date);
  }
}

/** A price in the reader's language, with cents only when it has some. */
function formatPrice(cents: string | undefined, currency: string | undefined, locale: InterfaceLocale): string | undefined {
  const amount = Number(cents);
  if (!cents || !Number.isSafeInteger(amount) || !currency || !/^[a-z]{3}$/i.test(currency)) return undefined;
  const digits = amount % 100 === 0 ? 0 : 2;
  return new Intl.NumberFormat(intlLocale(locale), { style: "currency", currency: currency.toUpperCase(), minimumFractionDigits: digits, maximumFractionDigits: digits }).format(amount / 100);
}

/** The subject of a promo ending email, which the worker sets as it sends it. */
export function promoEndingSubject(variables: Record<string, string>): string {
  const locale = normalizeInterfaceLocale(variables.locale) ?? "en";
  const plan = variables.planName ?? "";
  const date = formatDay(variables.date, locale, variables.timeZone);
  return { en: `Your ${plan} plan ends on ${date}`, fr: `Votre forfait ${plan} se termine le ${date}`, es: `Su plan ${plan} termina el ${date}`, sr: `Paket ${plan} ističe ${date}` }[locale];
}

/**
 * To a business's owners a week before its promo plan ends: when, and what
 * the subscription becomes. It moves to the plan's tier at that tier's price,
 * or it ends and the business goes back to the free plan.
 */
function promoEnding({ app, locale }: Context, variables: Record<string, string>): EmailContent {
  const business = variables.businessName?.trim() ?? "";
  const plan = variables.planName ?? "";
  const tier = variables.tier ?? "";
  const date = formatDay(variables.date, locale, variables.timeZone);
  const price = formatPrice(variables.priceCents, variables.currency, locale);
  const annual = variables.interval === "annual";
  const cancel = variables.ending === "cancel";
  const copy = {
    en: {
      intro: cancel
        ? `On ${date}, ${plan} ends for ${business}, and so does your subscription. ${business} then moves to the free plan.`
        : `On ${date}, ${business} moves from ${plan} to ${tier}. Your subscription continues on ${tier} ${price ? `at ${price} ${annual ? "a year" : "a month"}` : "at its standard price"}, charged to your saved payment method.`,
      next: cancel ? "To keep a paid plan, choose one in Settings > Plan before then." : "You don't need to do anything. To choose another plan or cancel, go to Settings > Plan before then.",
      button: "Open Settings > Plan",
      reason: `You're receiving this email because you own ${business} on ${app}.`,
    },
    fr: {
      intro: cancel
        ? `Le ${date}, le forfait ${plan} de ${business} se termine, ainsi que votre abonnement. ${business} passe alors au forfait gratuit.`
        : `Le ${date}, ${business} passe du forfait ${plan} au forfait ${tier}. Votre abonnement continue avec ${tier} ${price ? `à ${price} ${annual ? "par an" : "par mois"}` : "à son prix habituel"}, débité sur votre moyen de paiement enregistré.`,
      next: cancel ? "Pour garder un forfait payant, choisissez-en un dans Réglages > Forfait d'ici là." : "Vous n'avez rien à faire. Pour choisir un autre forfait ou résilier, allez dans Réglages > Forfait d'ici là.",
      button: "Ouvrir Réglages > Forfait",
      reason: `Vous recevez ce courriel parce que vous êtes propriétaire de ${business} sur ${app}.`,
    },
    es: {
      intro: cancel
        ? `El ${date}, el plan ${plan} de ${business} termina, y también su suscripción. ${business} pasa entonces al plan gratuito.`
        : `El ${date}, ${business} pasa del plan ${plan} al plan ${tier}. Su suscripción continúa con ${tier} ${price ? `por ${price} ${annual ? "al año" : "al mes"}` : "a su precio habitual"}, con cargo a su método de pago guardado.`,
      next: cancel ? "Para mantener un plan de pago, elija uno en Configuración > Plan antes de esa fecha." : "No tiene que hacer nada. Para elegir otro plan o cancelar, vaya a Configuración > Plan antes de esa fecha.",
      button: "Abrir Configuración > Plan",
      reason: `Recibe este correo porque es propietario de ${business} en ${app}.`,
    },
    sr: {
      intro: cancel
        ? `Dana ${date} ističe paket ${plan} firme ${business}, a sa njim i pretplata. Firma ${business} tada prelazi na besplatni paket.`
        : `Dana ${date} firma ${business} prelazi sa paketa ${plan} na paket ${tier}. Pretplata se nastavlja na paketu ${tier} ${price ? `po ceni od ${price} ${annual ? "godišnje" : "mesečno"}` : "po redovnoj ceni"}, a naplaćuje se sa sačuvanog načina plaćanja.`,
      next: cancel ? "Da biste zadržali plaćeni paket, izaberite ga u odeljku Podešavanja > Paket pre tog datuma." : "Ne morate ništa da radite. Da biste izabrali drugi paket ili otkazali pretplatu, otvorite Podešavanja > Paket pre tog datuma.",
      button: "Otvori Podešavanja > Paket",
      reason: `Ovaj imejl ste dobili jer ste vlasnik firme ${business} na servisu ${app}.`,
    },
  }[locale];
  return {
    locale,
    eyebrow: business || undefined,
    heading: promoEndingSubject(variables),
    blocks: [
      { kind: "paragraph", text: copy.intro },
      { kind: "paragraph", text: copy.next },
      { kind: "button", label: copy.button, url: variables.url ?? "" },
    ],
    reason: { text: copy.reason },
  };
}

/** Where each alert's button leads in the dashboard, and what the alert is about. */
const ALERTS: Record<string, { path: string; label: string; about: string }> = {
  // Home lists voice messages under Action required, with the number to call back.
  voiceMessage: { path: "/", label: "Open the dashboard", about: "voice messages" },
  pausedSms: { path: "/messages", label: "Open Messages", about: "new text messages" },
  smsFailed: { path: "/messages", label: "Open Messages", about: "failed customer texts" },
  aiReplyFailed: { path: "/messages", label: "Open Messages", about: "failed AI replies" },
  widgetChat: { path: "/messages", label: "Open Messages", about: "website chat messages" },
  liveChatRequest: { path: "/messages", label: "Open Messages", about: "visitors asking for a person" },
  transferFailed: { path: "/calls", label: "Open Calls", about: "failed call transfers" },
  calendarSync: { path: "/integrations", label: "Open Integrations", about: "calendar sync issues" },
  webhookDisabled: { path: "/integrations/webhooks", label: "Open Webhooks", about: "webhook endpoints turned off" },
  dailyDigest: { path: "/", label: "Open the dashboard", about: "the daily summary" },
};

/**
 * An alert to a business's team. Its subject and message are written in
 * English when the alert is queued, the same words a text alert gets, so the
 * email around them is in English too. The worker adds the business, the
 * kind of alert and the dashboard's address; without them the email is just
 * the message.
 */
function operatorAlert({ app, heading }: { app: string; heading: string }, variables: Record<string, string>): EmailContent {
  const message = variables.message?.trim() || `${app} notification`;
  const business = variables.businessName?.trim();
  const kind = variables.eventKind ?? "";
  const alert = ALERTS[kind];
  const base = variables.appUrl ? withoutTrailingSlashes(variables.appUrl) : undefined;
  const paragraphs = paragraphsOf(message);
  const blocks: Block[] = kind === "widgetChat"
    ? [
      { kind: "paragraph", text: "A visitor wrote this in the chat on your website:" },
      ...paragraphs.map((text): Block => ({ kind: "quote", text })),
      { kind: "paragraph", text: "You get one alert per chat each day, so later messages in this chat today won't send another email. Open Messages to read the whole chat and reply." },
    ]
    : paragraphs.map((text): Block => ({ kind: "paragraph", text }));
  if (alert && base) blocks.push({ kind: "button", label: alert.label, url: `${base}${alert.path}` });
  const settings = base ? { label: "Settings > Notifications", url: `${base}/settings/notifications` } : undefined;
  const goTo = settings ? "go to" : "go to Settings > Notifications.";
  const reason = !business || !alert
    ? undefined
    : kind === "dailyDigest"
      ? { text: `You're receiving this email because your ${app} account has the daily summary on for ${business}. To stop getting alerts by email, ${goTo}`, link: settings }
      : { text: `You're receiving this email because your ${app} account has email alerts on for ${alert.about} at ${business}. To choose which alerts you get, ${goTo}`, link: settings };
  // A heading that already names the business needs no line above it.
  return { locale: "en", eyebrow: business && !heading.includes(business) ? business : undefined, heading, blocks, reason };
}

/** What the call's page shows as its summary: a booking, a message, the receptionist's summary or how the call ended. */
export type CallTranscriptOutcome =
  | { kind: "booked"; serviceName: string | null; startsAt: string }
  | { kind: "booking_in_progress"; serviceName: string | null; startsAt: string | null }
  | { kind: "message_taking"; summary?: string }
  | { kind: "summary"; summary: string }
  | { kind: "disposition"; disposition: string }
  | { kind: "none" };

/** One turn of the conversation, with the seconds from the call's start to about when it began. */
export type CallTranscriptTurn = { speaker: "caller" | "assistant"; text: string; atSeconds: number };

/**
 * The email someone on a business's team gets after a call, which the worker
 * builds as it sends it. Its own words are in the reader's dashboard language;
 * the summary stays in the business's and the turns in whatever was spoken.
 */
export type CallTranscriptEmail = {
  locale: InterfaceLocale;
  businessName: string;
  /** The business's time zone, which the call's start is written in. */
  timeZone: string;
  channel: "phone" | "website" | "test";
  callerName: string | null;
  callerPhone: string | null;
  startedAt: string;
  durationSeconds: number | null;
  outcome: CallTranscriptOutcome;
  callUrl: string;
  settingsUrl: string;
  /** Every turn, when the business sends the whole conversation; null for the summary and a link. */
  turns: CallTranscriptTurn[] | null;
};

/** A file sent with an email. */
export type EmailAttachment = { filename: string; content: string; contentType: string };

// Gmail hides an email's HTML past about 102 KB behind "View entire message".
// A long call's turns stop at this many bytes of HTML, and the whole
// conversation goes in a text file.
const TRANSCRIPT_HTML_BUDGET = 80_000;

type CallEmailCopy = {
  subject: { transcript: string; summary: string; testTranscript: string; testSummary: string };
  who: { visitor: string; unknown: string };
  heading: { named: (name: string) => string; visitor: string; unknown: string; test: string };
  labels: { when: string; length: string; caller: string; call: string; summary: string };
  channels: Record<CallTranscriptEmail["channel"], string>;
  notGiven: string;
  button: string;
  summaryOnly: string;
  transcript: string;
  speakers: Record<CallTranscriptTurn["speaker"], string>;
  /** What stands in for a card or ID number someone said. */
  removed: { card: string; id: string };
  cut: string;
  reason: { gets: (app: string, business: string) => string; copy: string; stop: string; settings: string };
  outcome: {
    booked: (service: string, at: string) => string;
    scheduling: string;
    schedulingWith: (service: string) => string;
    schedulingWithAt: (service: string, at: string) => string;
    messageTaken: string;
    genericService: string;
    unspecifiedTime: string;
    none: string;
    dispositions: Record<"contactBlocked" | "abuse" | "spam" | "transferCompleted" | "transferBusy" | "transferFailed" | "voicemail" | "busy" | "noAnswer" | "technicalIssue" | "canceled" | "completed", string>;
  };
};

// The outcome sentences are the call page's (apps/admin/public/locales/*/calls.json).
const CALL_EMAIL_COPY: Record<InterfaceLocale, CallEmailCopy> = {
  en: {
    subject: { transcript: "Call transcript", summary: "Call summary", testTranscript: "Test call transcript", testSummary: "Test call summary" },
    who: { visitor: "website visitor", unknown: "unknown caller" },
    heading: { named: (name) => `Call with ${name}`, visitor: "Website call with a visitor", unknown: "Call from an unknown caller", test: "Test call from the dashboard" },
    labels: { when: "When", length: "Length", caller: "Caller", call: "Call", summary: "Summary" },
    channels: { phone: "Phone call", website: "Website call", test: "Dashboard test call" },
    notGiven: "Not given",
    button: "Open the call",
    summaryOnly: "Open the call to read the whole conversation.",
    transcript: "Transcript",
    speakers: { caller: "Caller", assistant: "Assistant" },
    removed: { card: "[card number removed]", id: "[ID number removed]" },
    cut: "The transcript stops here because it's long. The whole conversation is in the attached file and on the call's page.",
    reason: { gets: (app, business) => `You're receiving this email because your ${app} account gets an email after each call at ${business}.`, copy: "This copy stays in your mailbox after the dashboard deletes the transcript.", stop: "To stop these emails, go to", settings: "Settings > Notifications" },
    outcome: {
      booked: (service, at) => `Caller booked ${service} for ${at}.`,
      scheduling: "Caller started scheduling, but no appointment was confirmed.",
      schedulingWith: (service) => `Caller discussed scheduling ${service}, but no appointment was confirmed.`,
      schedulingWithAt: (service, at) => `Caller discussed scheduling ${service} for ${at}, but no appointment was confirmed.`,
      messageTaken: "Caller left a message for follow-up.",
      genericService: "an appointment",
      unspecifiedTime: "an unspecified time",
      none: "Caller asked questions, but no final outcome was captured yet.",
      dispositions: {
        contactBlocked: "Call was blocked before the assistant answered.",
        abuse: "AI ended this as an abusive call.",
        spam: "AI ended this as a spam call.",
        transferCompleted: "Call was transferred successfully.",
        transferBusy: "Transfer was attempted, but the destination line was busy.",
        transferFailed: "Transfer was attempted, but it did not complete successfully.",
        voicemail: "Call ended in voicemail or message capture.",
        busy: "Call ended because the line was busy.",
        noAnswer: "Call ended without an answer.",
        technicalIssue: "Call ended because of a technical issue before a final outcome was captured.",
        canceled: "Call was canceled before a final outcome was captured.",
        completed: "Call completed, but no booking outcome was captured.",
      },
    },
  },
  fr: {
    subject: { transcript: "Transcription d'appel", summary: "Résumé d'appel", testTranscript: "Transcription de l'appel test", testSummary: "Résumé de l'appel test" },
    who: { visitor: "visiteur du site web", unknown: "appelant inconnu" },
    heading: { named: (name) => `Appel avec ${name}`, visitor: "Appel d'un visiteur du site web", unknown: "Appel d'un appelant inconnu", test: "Appel test depuis le tableau de bord" },
    labels: { when: "Date", length: "Durée", caller: "Appelant", call: "Appel", summary: "Résumé" },
    channels: { phone: "Appel téléphonique", website: "Appel depuis le site web", test: "Appel test du tableau de bord" },
    notGiven: "Non indiqué",
    button: "Ouvrir l'appel",
    summaryOnly: "Ouvrez l'appel pour lire toute la conversation.",
    transcript: "Transcription",
    speakers: { caller: "Appelant", assistant: "Assistant" },
    removed: { card: "[numéro de carte retiré]", id: "[numéro d'identité retiré]" },
    cut: "La transcription s'arrête ici parce qu'elle est longue. La conversation complète se trouve dans le fichier joint et sur la page de l'appel.",
    reason: { gets: (app, business) => `Vous recevez ce courriel parce que votre compte ${app} reçoit un courriel après chaque appel chez ${business}.`, copy: "Cette copie reste dans votre boîte de réception même après la suppression de la transcription dans le tableau de bord.", stop: "Pour ne plus recevoir ces courriels, allez dans", settings: "Réglages > Notifications" },
    outcome: {
      booked: (service, at) => `L'appelant a réservé ${service} pour le ${at}.`,
      scheduling: "L'appelant a commencé la prise de rendez-vous, mais aucun rendez-vous n'a été confirmé.",
      schedulingWith: (service) => `L'appelant a discuté de la planification de ${service}, mais aucun rendez-vous n'a été confirmé.`,
      schedulingWithAt: (service, at) => `L'appelant a discuté de la planification de ${service} pour le ${at}, mais aucun rendez-vous n'a été confirmé.`,
      messageTaken: "L'appelant a laissé un message pour suivi.",
      genericService: "un rendez-vous",
      unspecifiedTime: "une heure non précisée",
      none: "L'appelant a posé des questions, mais aucun résultat final n'a encore été capturé.",
      dispositions: {
        contactBlocked: "L'appel a été bloqué avant que l'assistant réponde.",
        abuse: "L'IA a mis fin à cet appel pour comportement abusif.",
        spam: "L'IA a mis fin à cet appel comme appel indésirable.",
        transferCompleted: "L'appel a été transféré avec succès.",
        transferBusy: "Un transfert a été tenté, mais la ligne de destination était occupée.",
        transferFailed: "Un transfert a été tenté, mais il n'a pas abouti.",
        voicemail: "L'appel s'est terminé par une boîte vocale ou une prise de message.",
        busy: "L'appel s'est terminé parce que la ligne était occupée.",
        noAnswer: "L'appel s'est terminé sans réponse.",
        technicalIssue: "L'appel s'est terminé à cause d'un problème technique avant qu'un résultat final ne soit capturé.",
        canceled: "L'appel a été annulé avant qu'un résultat final ne soit capturé.",
        completed: "L'appel s'est terminé, mais aucun résultat de réservation n'a été capturé.",
      },
    },
  },
  es: {
    subject: { transcript: "Transcripción de llamada", summary: "Resumen de llamada", testTranscript: "Transcripción de la llamada de prueba", testSummary: "Resumen de la llamada de prueba" },
    who: { visitor: "visitante del sitio web", unknown: "cliente sin identificar" },
    heading: { named: (name) => `Llamada con ${name}`, visitor: "Llamada de un visitante del sitio web", unknown: "Llamada de un cliente sin identificar", test: "Llamada de prueba desde el panel" },
    labels: { when: "Fecha", length: "Duración", caller: "Cliente", call: "Llamada", summary: "Resumen" },
    channels: { phone: "Llamada telefónica", website: "Llamada desde el sitio web", test: "Llamada de prueba del panel" },
    notGiven: "No indicado",
    button: "Abrir la llamada",
    summaryOnly: "Abra la llamada para leer toda la conversación.",
    transcript: "Transcripción",
    speakers: { caller: "Cliente", assistant: "Asistente" },
    removed: { card: "[número de tarjeta eliminado]", id: "[número de identificación eliminado]" },
    cut: "La transcripción se detiene aquí porque es larga. La conversación completa está en el archivo adjunto y en la página de la llamada.",
    reason: { gets: (app, business) => `Recibe este correo porque su cuenta de ${app} recibe un correo después de cada llamada a ${business}.`, copy: "Esta copia se queda en su buzón aunque el panel elimine la transcripción.", stop: "Para dejar de recibir estos correos, vaya a", settings: "Configuración > Notificaciones" },
    outcome: {
      booked: (service, at) => `El cliente reservó ${service} para el ${at}.`,
      scheduling: "El cliente empezó a pedir una cita, pero no se confirmó ninguna.",
      schedulingWith: (service) => `El cliente habló de reservar ${service}, pero no se confirmó ninguna cita.`,
      schedulingWithAt: (service, at) => `El cliente habló de reservar ${service} para el ${at}, pero no se confirmó ninguna cita.`,
      messageTaken: "El cliente dejó un mensaje para que le devuelvan la llamada.",
      genericService: "una cita",
      unspecifiedTime: "una hora sin especificar",
      none: "El cliente hizo preguntas, pero aún no se ha registrado un resultado final.",
      dispositions: {
        contactBlocked: "La llamada se bloqueó antes de que respondiera el asistente.",
        abuse: "La IA finalizó la llamada por comportamiento abusivo.",
        spam: "La IA finalizó la llamada por ser spam.",
        transferCompleted: "La llamada se transfirió correctamente.",
        transferBusy: "Se intentó transferir la llamada, pero la línea de destino estaba ocupada.",
        transferFailed: "Se intentó transferir la llamada, pero no se completó.",
        voicemail: "La llamada terminó en el buzón de voz o con un mensaje.",
        busy: "La llamada terminó porque la línea estaba ocupada.",
        noAnswer: "La llamada terminó sin respuesta.",
        technicalIssue: "La llamada terminó por un problema técnico antes de registrar un resultado final.",
        canceled: "La llamada se canceló antes de registrar un resultado final.",
        completed: "La llamada terminó, pero no se registró ninguna reserva.",
      },
    },
  },
  sr: {
    subject: { transcript: "Transkript poziva", summary: "Rezime poziva", testTranscript: "Transkript probnog poziva", testSummary: "Rezime probnog poziva" },
    who: { visitor: "posetilac sajta", unknown: "nepoznat pozivalac" },
    heading: { named: (name) => `Poziv: ${name}`, visitor: "Poziv posetioca sajta", unknown: "Poziv nepoznatog pozivaoca", test: "Probni poziv iz kontrolne table" },
    labels: { when: "Vreme", length: "Trajanje", caller: "Pozivalac", call: "Poziv", summary: "Rezime" },
    channels: { phone: "Telefonski poziv", website: "Poziv sa sajta", test: "Probni poziv iz kontrolne table" },
    notGiven: "Nije navedeno",
    button: "Otvori poziv",
    summaryOnly: "Otvorite poziv da biste pročitali ceo razgovor.",
    transcript: "Transkript",
    speakers: { caller: "Pozivalac", assistant: "Asistent" },
    removed: { card: "[broj kartice uklonjen]", id: "[identifikacioni broj uklonjen]" },
    cut: "Transkript se ovde prekida jer je dugačak. Ceo razgovor je u priloženoj datoteci i na stranici poziva.",
    reason: { gets: (app, business) => `Ovaj imejl ste dobili jer Vaš ${app} nalog dobija imejl posle svakog poziva upućenog firmi ${business}.`, copy: "Ova kopija ostaje u Vašem sandučetu i kada kontrolna tabla obriše transkript.", stop: "Da ne biste više dobijali ove imejlove, otvorite", settings: "Podešavanja > Obaveštenja" },
    outcome: {
      booked: (service, at) => `Pozivalac je zakazao: ${service}, za ${at}.`,
      scheduling: "Pozivalac je započeo zakazivanje, ali nijedan termin nije potvrđen.",
      schedulingWith: (service) => `Pozivalac je razgovarao o zakazivanju (${service}), ali nijedan termin nije potvrđen.`,
      schedulingWithAt: (service, at) => `Pozivalac je razgovarao o zakazivanju (${service}) za ${at}, ali nijedan termin nije potvrđen.`,
      messageTaken: "Pozivalac je ostavio poruku za povratni kontakt.",
      genericService: "termin",
      unspecifiedTime: "neodređeno vreme",
      none: "Pozivalac je postavljao pitanja, ali konačan ishod još nije zabeležen.",
      dispositions: {
        contactBlocked: "Poziv je blokiran pre nego što se asistent javio.",
        abuse: "AI je prekinuo ovaj poziv kao uvredljiv.",
        spam: "AI je prekinuo ovaj poziv kao neželjen.",
        transferCompleted: "Poziv je uspešno preusmeren.",
        transferBusy: "Pokušano je preusmeravanje, ali je odredišna linija bila zauzeta.",
        transferFailed: "Pokušano je preusmeravanje, ali nije uspešno završeno.",
        voicemail: "Poziv se završio govornom poštom ili ostavljenom porukom.",
        busy: "Poziv je završen jer je linija bila zauzeta.",
        noAnswer: "Poziv je završen bez odgovora.",
        technicalIssue: "Poziv je završen zbog tehničkog problema pre nego što je zabeležen konačan ishod.",
        canceled: "Poziv je otkazan pre nego što je zabeležen konačan ishod.",
        completed: "Poziv je završen, ali ishod zakazivanja nije zabeležen.",
      },
    },
  },
};

/** A caller's name as one short line, since it comes from the call. */
function callerName(email: CallTranscriptEmail): string | null {
  const name = email.callerName?.replace(/\s+/g, " ").trim().slice(0, 80);
  return name || null;
}

/** "4 min" or "45 sec", for the subject; null when the length isn't known. */
function shortLength(seconds: number | null, locale: InterfaceLocale): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null;
  const tag = intlLocale(locale);
  if (seconds < 60) return new Intl.NumberFormat(tag, { style: "unit", unit: "second", unitDisplay: "short" }).format(Math.max(0, Math.round(seconds)));
  return new Intl.NumberFormat(tag, { style: "unit", unit: "minute", unitDisplay: "short" }).format(Math.round(seconds / 60));
}

/** "4 min 12 sec", for the facts. */
function fullLength(seconds: number, locale: InterfaceLocale): string {
  const tag = intlLocale(locale);
  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  const parts = [
    ...(minutes > 0 ? [new Intl.NumberFormat(tag, { style: "unit", unit: "minute", unitDisplay: "short" }).format(minutes)] : []),
    ...(rest > 0 || minutes === 0 ? [new Intl.NumberFormat(tag, { style: "unit", unit: "second", unitDisplay: "short" }).format(rest)] : []),
  ];
  return parts.join(" ");
}

/** A moment in the business's time zone, in the reader's language. Serbian gets digits, since a month's name would need declining. */
function formatMoment(iso: string, locale: InterfaceLocale, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(intlLocale(locale), { ...options, timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat(intlLocale(locale), { ...options, timeZone: "UTC" }).format(date);
  }
}

function callStart(email: CallTranscriptEmail): string {
  const options: Intl.DateTimeFormatOptions = email.locale === "sr"
    ? { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }
    : { weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" };
  return formatMoment(email.startedAt, email.locale, email.timeZone, options);
}

/** The call page's summary line (apps/admin/src/lib/call-outcome.ts), with times in the business's time zone. */
function outcomeSentence(email: CallTranscriptEmail): string {
  const copy = CALL_EMAIL_COPY[email.locale].outcome;
  const outcome = email.outcome;
  const at = (iso: string) => formatMoment(iso, email.locale, email.timeZone, { dateStyle: "medium", timeStyle: "short" });
  switch (outcome.kind) {
    case "booked":
      return copy.booked(outcome.serviceName ?? copy.genericService, outcome.startsAt ? at(outcome.startsAt) : copy.unspecifiedTime);
    case "booking_in_progress":
      if (outcome.serviceName && outcome.startsAt) return copy.schedulingWithAt(outcome.serviceName, at(outcome.startsAt));
      return outcome.serviceName ? copy.schedulingWith(outcome.serviceName) : copy.scheduling;
    case "message_taking":
      return copy.messageTaken;
    case "summary":
      return outcome.summary ? withoutCardAndIdNumbers(outcome.summary, CALL_EMAIL_COPY[email.locale].removed) : copy.none;
    case "disposition":
      return dispositionSentence(outcome.disposition, copy);
    default:
      return copy.none;
  }
}

function dispositionSentence(disposition: string, copy: CallEmailCopy["outcome"]): string {
  const value = disposition.trim().toLowerCase();
  const kinds: Array<[(value: string) => boolean, keyof CallEmailCopy["outcome"]["dispositions"]]> = [
    [(v) => v.includes("blocked_contact"), "contactBlocked"],
    [(v) => v.includes("abuse"), "abuse"],
    [(v) => v.includes("spam"), "spam"],
    [(v) => v.includes("transfer_completed"), "transferCompleted"],
    [(v) => v.includes("transfer_busy"), "transferBusy"],
    [(v) => v.includes("transfer_"), "transferFailed"],
    [(v) => v.includes("voicemail"), "voicemail"],
    [(v) => v.includes("busy"), "busy"],
    [(v) => v.includes("no_answer") || v.includes("missed"), "noAnswer"],
    [(v) => v.includes("failed"), "technicalIssue"],
    [(v) => v.includes("canceled") || v.includes("cancelled"), "canceled"],
    [(v) => v.includes("completed"), "completed"],
  ];
  const kind = kinds.find(([matches]) => matches(value))?.[1];
  return kind ? copy.dispositions[kind] : copy.none;
}

/** "Call transcript: Jane Doe, 4 min", with no phone number: subjects show on lock screens and in mail logs. */
export function callTranscriptSubject(email: CallTranscriptEmail): string {
  const copy = CALL_EMAIL_COPY[email.locale];
  const transcript = email.turns !== null;
  const length = shortLength(email.durationSeconds, email.locale);
  const colon = email.locale === "fr" ? " :" : ":";
  if (email.channel === "test") {
    const subject = transcript ? copy.subject.testTranscript : copy.subject.testSummary;
    return length ? `${subject}${colon} ${length}` : subject;
  }
  const who = callerName(email) ?? (email.channel === "website" ? copy.who.visitor : copy.who.unknown);
  return `${transcript ? copy.subject.transcript : copy.subject.summary}${colon} ${length ? `${who}, ${length}` : who}`;
}

/** m:ss from the call's start. */
function turnTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function callTranscript(app: string, email: CallTranscriptEmail): { content: EmailContent; attachment?: EmailAttachment } {
  const copy = CALL_EMAIL_COPY[email.locale];
  const name = callerName(email);
  const heading = email.channel === "test" ? copy.heading.test : name ? copy.heading.named(name) : email.channel === "website" ? copy.heading.visitor : copy.heading.unknown;
  const caller = [name, email.callerPhone?.trim()].filter(Boolean).join(", ") || copy.notGiven;
  const facts: Array<{ label: string; value: string }> = [
    { label: copy.labels.when, value: callStart(email) },
    ...(email.durationSeconds !== null && Number.isFinite(email.durationSeconds) ? [{ label: copy.labels.length, value: fullLength(email.durationSeconds, email.locale) }] : []),
    // The person who made a test call knows who called.
    ...(email.channel === "test" ? [] : [{ label: copy.labels.caller, value: caller }]),
    { label: copy.labels.call, value: copy.channels[email.channel] },
    { label: copy.labels.summary, value: outcomeSentence(email) },
  ];
  const lines = (email.turns ?? []).map((turn) => ({ at: turnTime(turn.atSeconds), speaker: copy.speakers[turn.speaker], text: withoutCardAndIdNumbers(turn.text.trim(), copy.removed) })).filter((line) => line.text);
  const shown = withinBudget(lines, email.locale);
  const cut = shown.length < lines.length;
  const blocks: Block[] = [{ kind: "facts", rows: facts }];
  if (email.turns === null) {
    blocks.push({ kind: "paragraph", text: copy.summaryOnly }, { kind: "button", label: copy.button, url: email.callUrl });
  } else {
    blocks.push({ kind: "button", label: copy.button, url: email.callUrl }, { kind: "transcript", title: copy.transcript, lines: shown });
    if (cut) blocks.push({ kind: "paragraph", text: copy.cut });
  }
  const reason = [copy.reason.gets(app, email.businessName), ...(email.turns !== null ? [copy.reason.copy] : []), copy.reason.stop].join(" ");
  const content: EmailContent = { locale: email.locale, eyebrow: email.businessName, heading, blocks, reason: { text: reason, link: { label: copy.reason.settings, url: email.settingsUrl } } };
  if (!cut) return { content };
  // The whole conversation, as the email's plain text would show it.
  const file = renderText({ locale: email.locale, eyebrow: email.businessName, heading, blocks: [{ kind: "facts", rows: facts }, { kind: "transcript", title: copy.transcript, lines }] });
  return { content, attachment: { filename: `call-${callDay(email)}.txt`, content: `${file}\n`, contentType: "text/plain; charset=utf-8" } };
}

/** The call's day in the business's time zone, as 2026-10-26. */
function callDay(email: CallTranscriptEmail): string {
  const options: Intl.DateTimeFormatOptions = { year: "numeric", month: "2-digit", day: "2-digit" };
  const date = new Date(email.startedAt);
  try {
    return new Intl.DateTimeFormat("en-CA", { ...options, timeZone: email.timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-CA", { ...options, timeZone: "UTC" }).format(date);
  }
}

/** The turns that fit the HTML budget, all of them for any call but a long one. */
function withinBudget(lines: TranscriptLine[], locale: InterfaceLocale): TranscriptLine[] {
  const encoder = new TextEncoder();
  let bytes = 0;
  for (let index = 0; index < lines.length; index += 1) {
    bytes += encoder.encode(transcriptLineHtml(lines[index]!, locale)).length;
    if (bytes > TRANSCRIPT_HTML_BUDGET) return lines.slice(0, index);
  }
  return lines;
}

// The two helpers below loop instead of using regular expressions, which
// backtrack on long runs of slashes or blank space in a message.

/** The message's paragraphs: its runs of lines between blank ones. */
function paragraphsOf(message: string): string[] {
  const paragraphs: string[] = [];
  let lines: string[] = [];
  for (const line of [...message.split("\n"), ""]) {
    if (line.trim()) {
      lines.push(line);
    } else if (lines.length > 0) {
      paragraphs.push(lines.join("\n").trim());
      lines = [];
    }
  }
  return paragraphs;
}

function withoutTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") end -= 1;
  return url.slice(0, end);
}

/** Feedback from the dashboard, to the deployment's own inbox, as plain text. */
function feedbackBody(variables: Record<string, string>, appName: string): string {
  const sender = variables.userEmail ? (variables.userName ? `${variables.userName} (${variables.userEmail})` : variables.userEmail) : variables.userName;
  const details = [
    sender ? `From: ${sender}` : "",
    variables.businessName ? `Business: ${variables.businessName}` : "",
    variables.pagePath ? `Page: ${variables.pagePath}` : "",
  ].filter(Boolean);
  return [
    `New feedback from the ${appName} dashboard.`,
    ...(details.length ? [details.join("\n")] : []),
    `Message:\n${variables.body?.trim() || "(empty)"}`,
    `You're receiving this email because this address is the feedback inbox (FEEDBACK_TO_EMAIL) of ${appName}.${variables.userEmail ? ` To answer, write to ${variables.userEmail}.` : ""}`,
  ].join("\n\n");
}

function onboardingFollowupBody(variables: Record<string, string>, appName: string): string {
  const sender = variables.senderName ?? "";
  const business = variables.businessName ?? "";
  if (variables.locale === "es") {
    return [
      variables.firstName ? `Hola, ${variables.firstName}:` : "Hola:",
      "",
      `Soy ${sender}, fundador de ${appName}. Ayer configuró una recepcionista para ${business}. Gracias por probarla.`,
      "",
      "Me encantaría saber qué le pareció:",
      "",
      "1. ¿Le gustó? ¿Qué funcionó bien y qué no le convenció?",
      "2. ¿Qué deberíamos mejorar?",
      "3. ¿Piensa usarla de verdad, con su propio número de teléfono? Si no, ¿qué se lo impide?",
      "",
      "Puede responder a este correo. ¡Con dos líneas basta!",
      "",
      "Gracias de nuevo,",
      sender,
      `Fundador, ${appName}`,
    ].join("\n");
  }
  if (variables.locale === "sr") {
    return [
      variables.firstName ? `Zdravo, ${variables.firstName},` : "Zdravo,",
      "",
      `Ja sam ${sender}, osnivač servisa ${appName}. Juče ste podesili recepcionera za ${business}. Hvala što ste ga isprobali.`,
      "",
      "Voleo bih da čujem Vaše utiske:",
      "",
      "1. Da li Vam se dopao? Šta je dobro radilo, a šta Vam nije delovalo kako treba?",
      "2. Šta bi trebalo da poboljšamo?",
      "3. Da li planirate da ga zaista koristite, sa svojim brojem telefona? Ako ne, šta Vas sprečava?",
      "",
      "Možete da odgovorite na ovaj imejl, i dva reda su sasvim dovoljna!",
      "",
      "Hvala još jednom,",
      sender,
      `Osnivač, ${appName}`,
    ].join("\n");
  }
  if (variables.locale === "fr") {
    return [
      variables.firstName ? `Bonjour ${variables.firstName},` : "Bonjour,",
      "",
      `Je suis ${sender}, fondateur du service ${appName}. Vous avez configuré une réceptionniste pour ${business} hier. Merci de l'avoir essayée.`,
      "",
      "J'aimerais savoir ce que vous en avez pensé :",
      "",
      "1. Avez-vous aimé l'expérience ? Qu'est-ce qui a bien fonctionné, et qu'est-ce qui clochait ?",
      "2. Que devrions-nous améliorer ?",
      "3. Comptez-vous l'utiliser pour vrai, avec votre propre numéro de téléphone ? Sinon, qu'est-ce qui vous en empêche ?",
      "",
      "Vous pouvez répondre à ce courriel, et deux lignes suffiraient !",
      "",
      "Merci encore,",
      sender,
      `Fondateur, ${appName}`,
    ].join("\n");
  }
  return [
    variables.firstName ? `Hi ${variables.firstName},` : "Hi,",
    "",
    `I'm ${sender}, the founder of ${appName}. You set up a receptionist for ${business} yesterday. Thanks for giving it a try.`,
    "",
    "I'd love to hear what you thought:",
    "",
    "1. Did you like it? What worked, and what felt off?",
    "2. What should we improve?",
    "3. Do you plan to use it for real, with your own phone number? If not, what's stopping you?",
    "",
    "You can reply to this email, and two lines would be plenty!",
    "",
    "Thanks again,",
    sender,
    `Founder, ${appName}`,
  ].join("\n");
}

/** Plain text: one part per paragraph, each link on a line of its own after its label. */
function renderText(content: EmailContent): string {
  // French puts a space before a colon.
  const colon = content.locale === "fr" ? " :" : ":";
  const linked = (text: string, link?: Link) => link ? `${text} ${link.label}${colon}\n${link.url}` : text;
  const parts = [content.eyebrow ? `${content.eyebrow}\n${content.heading}` : content.heading];
  for (const block of content.blocks) {
    if (block.kind === "paragraph") parts.push(linked(block.text, block.link));
    else if (block.kind === "button") parts.push(`${block.label}${colon}\n${block.url}`);
    else if (block.kind === "code") parts.push(block.code);
    else if (block.kind === "facts") parts.push(block.rows.map((row) => `${row.label}${colon} ${row.value}`).join("\n"));
    else if (block.kind === "transcript") parts.push(block.title, ...block.lines.map((line) => `${line.at} ${line.speaker}${colon} ${line.text}`));
    else parts.push(block.text.split("\n").map((line) => `> ${line}`).join("\n"));
  }
  if (content.reason) parts.push(linked(content.reason.text, content.reason.link));
  return parts.join("\n\n");
}

const EMAIL_LOGO_HEIGHT = 48;

const STYLE = {
  eyebrow: "margin:0 0 8px;font-size:13px;font-weight:600;line-height:1.4;letter-spacing:0.04em;text-transform:uppercase;color:#6B7280;",
  heading: "margin:0 0 24px;font-size:24px;font-weight:600;line-height:1.3;color:#0B0B0D;",
  paragraph: "margin:0 0 16px;font-size:16px;line-height:1.6;color:#3D3D3D;",
  link: "color:#0B0B0D;font-weight:600;text-decoration:underline;",
  code: "margin:8px 0 24px;padding:16px 24px;background-color:#F3F4F6;border-radius:16px;font-size:32px;font-weight:600;line-height:1.25;letter-spacing:8px;color:#0B0B0D;text-align:center;",
  quote: "margin:0 0 16px;padding:12px 16px;border-left:4px solid #D1D5DB;background-color:#F9FAFB;font-size:16px;line-height:1.6;color:#3D3D3D;",
  reason: "margin:16px 0 0;padding-top:24px;border-top:1px solid #E5E7EB;font-size:13px;line-height:1.6;color:#6B7280;",
  reasonLink: "color:#6B7280;text-decoration:underline;",
  facts: "margin:0 0 24px;border-collapse:collapse;",
  factLabel: "padding:6px 16px 6px 0;font-size:14px;line-height:1.5;color:#6B7280;vertical-align:top;white-space:nowrap;",
  factValue: "padding:6px 0;font-size:15px;line-height:1.5;color:#0B0B0D;vertical-align:top;",
  transcriptTitle: "margin:8px 0 16px;font-size:18px;font-weight:600;line-height:1.3;color:#0B0B0D;",
};

// A long call has hundreds of turns, so each takes a short class instead of
// inline styles to keep the email under Gmail's clipping size. A mail app
// that drops these still shows each turn, with its speaker in bold.
const TRANSCRIPT_STYLES = `.t { margin: 0 0 12px; font-size: 15px; line-height: 1.55; color: #3D3D3D; }
      .t i { font-style: normal; font-size: 13px; color: #6B7280; }`;

function blockHtml(block: Block, locale: InterfaceLocale): string {
  switch (block.kind) {
    case "paragraph":
      return `<p style="${STYLE.paragraph}">${paragraphHtml(block.text, block.link, STYLE.link)}</p>`;
    case "button":
      // A table cell carries the colour, so Outlook draws the button too.
      return `<table role="presentation" border="0" cellspacing="0" cellpadding="0" style="margin:8px 0 24px;"><tr><td bgcolor="#0B0B0D" style="border-radius:12px;background-color:#0B0B0D;"><a href="${escapeHtml(block.url)}" target="_blank" style="display:inline-block;padding:14px 28px;font-size:16px;font-weight:600;line-height:1.2;color:#FFFFFF;text-decoration:none;border-radius:12px;">${escapeHtml(block.label)}</a></td></tr></table>`;
    case "code":
      return `<p style="${STYLE.code}">${escapeHtml(block.code)}</p>`;
    case "quote":
      return `<p style="${STYLE.quote}">${textHtml(block.text)}</p>`;
    case "facts":
      // The summary may be in a right-to-left language, so each value takes its own direction.
      return `<table role="presentation" border="0" cellspacing="0" cellpadding="0" style="${STYLE.facts}">${block.rows.map((row) => `<tr><td style="${STYLE.factLabel}">${escapeHtml(row.label)}</td><td dir="auto" style="${STYLE.factValue}">${textHtml(row.value)}</td></tr>`).join("")}</table>`;
    case "transcript":
      return `<h2 style="${STYLE.transcriptTitle}">${escapeHtml(block.title)}</h2>${block.lines.map((line) => transcriptLineHtml(line, locale)).join("")}`;
  }
}

/** One turn, its words in their own direction, as the call page shows them. */
function transcriptLineHtml(line: TranscriptLine, locale: InterfaceLocale): string {
  // French puts a space before a colon.
  return `<p class="t"><i>${escapeHtml(line.at)}</i> <b>${escapeHtml(line.speaker)}${locale === "fr" ? "&nbsp;:" : ":"}</b> <span dir="auto">${textHtml(line.text)}</span></p>`;
}

function paragraphHtml(text: string, link: Link | undefined, linkStyle: string): string {
  return link ? `${textHtml(text)} <a href="${escapeHtml(link.url)}" target="_blank" style="${linkStyle}">${escapeHtml(link.label)}</a>.` : textHtml(text);
}

function textHtml(text: string): string {
  return escapeHtml(text).replaceAll("\n", "<br />");
}

function renderHtml(content: EmailContent, { appName, logo, title, styles }: { appName: string; logo: BrandImage | undefined; title: string; styles?: string }): string {
  // The deployment's name as a wordmark, under the brand's PNG email logo when
  // it has one: mail clients such as Gmail and Outlook don't show SVG, and
  // some hide remote images until asked, so the name stays in text and the
  // logo needs no alt text of its own.
  const logoWidth = logo ? Math.round((logo.width * EMAIL_LOGO_HEIGHT) / logo.height) : 0;
  const logoImage = logo
    ? `<img src="${escapeHtml(logo.url)}" width="${logoWidth}" height="${EMAIL_LOGO_HEIGHT}" alt="" style="display:block;margin:0 auto 12px;border:0;outline:none;text-decoration:none;width:${logoWidth}px;height:${EMAIL_LOGO_HEIGHT}px;" />`
    : "";
  const wordmark = `<p style="margin:0;font-size:22px;font-weight:700;line-height:1.2;color:#0B0B0D;text-align:center;">${escapeHtml(appName)}</p>`;
  const body = [
    content.eyebrow ? `<p style="${STYLE.eyebrow}">${escapeHtml(content.eyebrow)}</p>` : "",
    `<h1 style="${STYLE.heading}">${escapeHtml(content.heading)}</h1>`,
    ...content.blocks.map((block) => blockHtml(block, content.locale)),
    content.reason ? `<p style="${STYLE.reason}">${paragraphHtml(content.reason.text, content.reason.link, STYLE.reasonLink)}</p>` : "",
  ].join("");

  return `<!doctype html>
<html lang="${escapeHtml(intlLocale(content.locale))}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <meta name="supported-color-schemes" content="light" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root { color-scheme: light; }
      @media only screen and (max-width: 620px) {
        .email-container { width: 100% !important; padding: 32px 20px !important; }
      }${styles ? `\n      ${styles}` : ""}
    </style>
  </head>
  <body style="margin:0;padding:0;background-color:#F3F4F6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" border="0" cellspacing="0" cellpadding="0" width="100%">
      <tr>
        <td align="center" style="padding:48px 16px;">
          <table role="presentation" class="email-container" border="0" cellspacing="0" cellpadding="0" width="600" style="width:600px;max-width:600px;background-color:#FFFFFF;border-radius:24px;padding:48px;">
            <tr>
              <td align="center" style="padding-bottom:32px;">
                ${logoImage}${wordmark}
              </td>
            </tr>
            <tr>
              <td align="left">
                ${body}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
