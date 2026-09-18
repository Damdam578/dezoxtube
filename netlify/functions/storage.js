const {
  getStore,
  connectLambda,
} = require("@netlify/blobs");

const DATA_STORE = "dezoxtube-data";
const SESSION_STORE = "dezoxtube-sessions";
const MODERATOR_ID = "1543536698913456162";

const MANAGE_GUILD = 0x20;
const ADMINISTRATOR = 0x8;

/* =========================================================
   NETLIFY BLOBS
========================================================= */

function dataStore() {
  return getStore(DATA_STORE);
}

function sessionStore() {
  return getStore(SESSION_STORE);
}

async function readJSON(store, key, fallback) {
  const value = await store.get(key, { type: "json" });
  return value == null ? fallback : value;
}

async function writeJSON(store, key, value) {
  await store.setJSON(key, value);
}

/* =========================================================
   RESPONSE
========================================================= */

function response(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

function ok(body = {}) {
  return response(200, body);
}

function error(statusCode, message) {
  return response(statusCode, { error: message });
}

/* =========================================================
   BODY / COOKIES
========================================================= */

function parseBody(event) {
  if (!event.body) return {};

  try {
    return JSON.parse(event.body);
  } catch {
    return {};
  }
}

function getCookies(event) {
  const header =
    event.headers?.cookie ||
    event.headers?.Cookie ||
    "";

  const cookies = {};

  header.split(";").forEach((part) => {
    const index = part.indexOf("=");

    if (index === -1) return;

    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();

    if (key) cookies[key] = decodeURIComponent(value);
  });

  return cookies;
}

function getSessionId(event) {
  const cookies = getCookies(event);
  return cookies.dezox_session || null;
}

/* =========================================================
   SESSION
========================================================= */

async function getSession(event) {
  const sessionId = getSessionId(event);

  if (!sessionId) return null;

  const store = sessionStore();

  const session = await readJSON(
    store,
    sessionId,
    null
  );

  if (!session) return null;

  if (
    session.expiresAt &&
    Number(session.expiresAt) < Date.now()
  ) {
    try {
      await store.delete(sessionId);
    } catch {}

    return null;
  }

  return session;
}

async function requireUser(event) {
  const session = await getSession(event);

  if (!session || !session.discordId) {
    return {
      error: error(401, "Tu dois être connecté avec Discord."),
    };
  }

  return {
    user: session,
  };
}

function isModerator(user) {
  return (
    user &&
    String(user.discordId) === MODERATOR_ID
  );
}

/* =========================================================
   DATA
========================================================= */

async function getData() {
  const store = dataStore();

  const data = await readJSON(
    store,
    "state",
    {
      ads: [],
      comments: [],
      votes: {},
      bans: {},
      moderationLogs: [],
    }
  );

  return {
    ads: Array.isArray(data.ads) ? data.ads : [],
    comments: Array.isArray(data.comments)
      ? data.comments
      : [],
    votes:
      data.votes &&
      typeof data.votes === "object"
        ? data.votes
        : {},
    bans:
      data.bans &&
      typeof data.bans === "object"
        ? data.bans
        : {},
    moderationLogs: Array.isArray(
      data.moderationLogs
    )
      ? data.moderationLogs
      : [],
  };
}

async function saveData(data) {
  await writeJSON(
    dataStore(),
    "state",
    data
  );
}

/* =========================================================
   BAN SYSTEM
========================================================= */

function getActiveBan(data, discordId) {
  const ban =
    data.bans[String(discordId)];

  if (!ban) return null;

  if (
    ban.expiresAt !== null &&
    Number(ban.expiresAt) <= Date.now()
  ) {
    delete data.bans[String(discordId)];
    return null;
  }

  return ban;
}

function isBanned(data, discordId) {
  return !!getActiveBan(
    data,
    discordId
  );
}

function durationToMs(duration) {
  switch (String(duration).toLowerCase()) {
    case "1h":
    case "1hour":
    case "1heure":
      return 60 * 60 * 1000;

    case "24h":
    case "24hours":
    case "24heures":
      return 24 * 60 * 60 * 1000;

    case "7d":
    case "7days":
    case "7jours":
      return 7 * 24 * 60 * 60 * 1000;

    case "30d":
    case "30days":
    case "30jours":
      return 30 * 24 * 60 * 60 * 1000;

    case "permanent":
    case "perm":
    case "perma":
      return null;

    default:
      return null;
  }
}

/* =========================================================
   DISCORD
========================================================= */

async function discordRequest(
  url,
  accessToken,
  options = {}
) {
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
    ...(options.headers || {}),
  };

  return fetch(url, {
    ...options,
    headers,
  });
}

async function getGuild(user, guildId) {
  if (!user?.accessToken) {
    return null;
  }

  try {
    const res = await discordRequest(
      `https://discord.com/api/users/@me/guilds`,
      user.accessToken
    );

    if (!res.ok) return null;

    const guilds = await res.json();

    return (
      guilds.find(
        (guild) =>
          String(guild.id) === String(guildId)
      ) || null
    );
  } catch (e) {
    console.error(
      "Discord guild error:",
      e
    );

    return null;
  }
}

function canManageGuild(guild) {
  if (!guild) return false;

  const permissions = Number(
    guild.permissions || 0
  );

  return (
    (permissions & ADMINISTRATOR) !== 0 ||
    (permissions & MANAGE_GUILD) !== 0
  );
}

/* =========================================================
   AD HELPERS
========================================================= */

function cleanTags(tags) {
  if (!Array.isArray(tags)) return [];

  return tags
    .map((tag) =>
      String(tag).trim().slice(0, 40)
    )
    .filter(Boolean)
    .slice(0, 20);
}

function normalizeMemberCount(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const number = Number(value);

  if (!Number.isFinite(number)) {
    return null;
  }

  return Math.max(
    0,
    Math.floor(number)
  );
}

function validInvite(link) {
  if (!link) return true;

  return /^https:\/\/(discord\.gg|discord\.com\/invite\/)[A-Za-z0-9-]+/i.test(
    String(link)
  );
}

function createId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

/* =========================================================
   LOGS
========================================================= */

function addModerationLog(
  data,
  action,
  moderator,
  details = {}
) {
  data.moderationLogs.unshift({
    id: createId("log"),
    action,
    moderatorDiscordId:
      moderator.discordId,
    moderatorUsername:
      moderator.username || "",
    timestamp: Date.now(),
    ...details,
  });

  data.moderationLogs =
    data.moderationLogs.slice(0, 500);
}

/* =========================================================
   CREATE AD
========================================================= */

async function createAd(
  event,
  user,
  body,
  data
) {
  if (isBanned(data, user.discordId)) {
    return error(
      403,
      "Tu es actuellement banni et ne peux pas publier."
    );
  }

  const guildId = String(
    body.guildId || ""
  );

  if (!guildId) {
    return error(
      400,
      "Serveur Discord invalide."
    );
  }

  const guild = await getGuild(
    user,
    guildId
  );

  if (!guild) {
    return error(
      403,
      "Impossible de vérifier ce serveur Discord."
    );
  }

  if (!canManageGuild(guild)) {
    return error(
      403,
      "Tu dois avoir la permission de gérer ce serveur."
    );
  }

  const description = String(
    body.description || ""
  )
    .trim()
    .slice(0, 2000);

  if (!description) {
    return error(
      400,
      "La description est obligatoire."
    );
  }

  const inviteLink = String(
    body.inviteLink ||
      body.invite ||
      ""
  ).trim();

  if (!validInvite(inviteLink)) {
    return error(
      400,
      "Lien Discord invalide."
    );
  }

  const memberCount =
    normalizeMemberCount(
      body.memberCount
    );

  /*
    Un seul affichage par serveur et par créateur.
  */

  const existing = data.ads.find(
    (ad) =>
      String(ad.guildId) === guildId &&
      String(ad.authorDiscordId) ===
        String(user.discordId)
  );

  if (existing) {
    return error(
      409,
      "Tu as déjà une publication pour ce serveur."
    );
  }

  const now = Date.now();

  const ad = {
    id: createId("ad"),

    guildId,

    guildName:
      guild.name ||
      body.guildName ||
      "",

    guildIcon:
      guild.icon ||
      body.guildIcon ||
      null,

    description,

    inviteLink,

    memberCount,

    tags: cleanTags(body.tags),

    image:
      body.image
        ? String(body.image).slice(0, 1000)
        : null,

    authorDiscordId:
      String(user.discordId),

    authorUsername:
      user.username || "",

    authorAvatar:
      user.avatar || null,

    createdAt: now,
    updatedAt: now,
  };

  data.ads.unshift(ad);

  await saveData(data);

  return ok({
    success: true,
    ad,
  });
}

/* =========================================================
   UPDATE AD
========================================================= */

async function updateAd(
  event,
  user,
  body,
  data
) {
  if (isBanned(data, user.discordId)) {
    return error(
      403,
      "Tu es actuellement banni et ne peux pas modifier une publication."
    );
  }

  const id = String(
    body.id || ""
  );

  let ad = null;

  if (id) {
    ad = data.ads.find(
      (item) =>
        String(item.id) === id
    );
  }

  /*
    Compatibilité si l'ancien frontend
    n'envoie pas d'ID.
  */

  if (!ad && body.guildId) {
    ad = data.ads.find(
      (item) =>
        String(item.guildId) ===
          String(body.guildId) &&
        String(item.authorDiscordId) ===
          String(user.discordId)
    );
  }

  if (!ad) {
    return error(
      404,
      "Publication introuvable."
    );
  }

  const owner =
    String(ad.authorDiscordId) ===
    String(user.discordId);

  if (!owner && !isModerator(user)) {
    return error(
      403,
      "Tu ne peux modifier que tes propres publications."
    );
  }

  const description =
    body.description !== undefined
      ? String(body.description)
          .trim()
          .slice(0, 2000)
      : ad.description;

  if (!description) {
    return error(
      400,
      "La description est obligatoire."
    );
  }

  const inviteLink =
    body.inviteLink !== undefined
      ? String(body.inviteLink).trim()
      : ad.inviteLink || "";

  if (!validInvite(inviteLink)) {
    return error(
      400,
      "Lien Discord invalide."
    );
  }

  ad.description = description;
  ad.inviteLink = inviteLink;

  if (
    body.memberCount !== undefined
  ) {
    ad.memberCount =
      normalizeMemberCount(
        body.memberCount
      );
  }

  if (body.tags !== undefined) {
    ad.tags = cleanTags(body.tags);
  }

  if (body.image !== undefined) {
    ad.image = body.image
      ? String(body.image).slice(0, 1000)
      : null;
  }

  ad.updatedAt = Date.now();

  await saveData(data);

  return ok({
    success: true,
    ad,
  });
}

/* =========================================================
   DELETE AD
========================================================= */

async function deleteAd(
  event,
  user,
  body,
  data
) {
  const id = String(
    body.id || ""
  );

  if (!id) {
    return error(
      400,
      "Publication invalide."
    );
  }

  const index =
    data.ads.findIndex(
      (ad) =>
        String(ad.id) === id
    );

  if (index === -1) {
    return error(
      404,
      "Publication introuvable."
    );
  }

  const ad = data.ads[index];

  const owner =
    String(ad.authorDiscordId) ===
    String(user.discordId);

  const moderator =
    isModerator(user);

  if (!owner && !moderator) {
    return error(
      403,
      "Tu ne peux supprimer que tes propres publications."
    );
  }

  data.ads.splice(index, 1);

  data.comments =
    data.comments.filter(
      (comment) =>
        String(comment.adId) !== id
    );

  delete data.votes[id];

  if (moderator && !owner) {
    addModerationLog(
      data,
      "delete_ad",
      user,
      {
        adId: id,
        authorDiscordId:
          ad.authorDiscordId,
        guildId: ad.guildId,
      }
    );
  }

  await saveData(data);

  return ok({
    success: true,
  });
}

/* =========================================================
   VOTE
========================================================= */

async function vote(
  event,
  user,
  body,
  data
) {
  const adId = String(
    body.id ||
      body.adId ||
      ""
  );

  if (!adId) {
    return error(
      400,
      "Publication invalide."
    );
  }

  const ad = data.ads.find(
    (item) =>
      String(item.id) === adId
  );

  if (!ad) {
    return error(
      404,
      "Publication introuvable."
    );
  }

  if (!Array.isArray(data.votes[adId])) {
    data.votes[adId] = [];
  }

  const voters =
    data.votes[adId];

  const userId =
    String(user.discordId);

  const index =
    voters.indexOf(userId);

  let voted;

  if (index === -1) {
    voters.push(userId);
    voted = true;
  } else {
    voters.splice(index, 1);
    voted = false;
  }

  await saveData(data);

  return ok({
    success: true,
    voted,
    votes: voters.length,
  });
}

/* =========================================================
   COMMENTS
========================================================= */

async function addComment(
  event,
  user,
  body,
  data
) {
  const adId = String(
    body.adId || ""
  );

  const text = String(
    body.text ||
      body.content ||
      ""
  )
    .trim()
    .slice(0, 1000);

  if (!adId || !text) {
    return error(
      400,
      "Commentaire invalide."
    );
  }

  const ad = data.ads.find(
    (item) =>
      String(item.id) === adId
  );

  if (!ad) {
    return error(
      404,
      "Publication introuvable."
    );
  }

  const comment = {
    id: createId("comment"),
    adId,

    discordId:
      String(user.discordId),

    username:
      user.username || "",

    avatar:
      user.avatar || null,

    text,

    createdAt: Date.now(),
  };

  data.comments.push(comment);

  await saveData(data);

  return ok({
    success: true,
    comment,
  });
}

async function deleteComment(
  event,
  user,
  body,
  data
) {
  const commentId = String(
    body.commentId ||
      body.id ||
      ""
  );

  const index =
    data.comments.findIndex(
      (comment) =>
        String(comment.id) ===
        commentId
    );

  if (index === -1) {
    return error(
      404,
      "Commentaire introuvable."
    );
  }

  const comment =
    data.comments[index];

  const owner =
    String(comment.discordId) ===
    String(user.discordId);

  if (!owner && !isModerator(user)) {
    return error(
      403,
      "Tu ne peux supprimer que tes propres commentaires."
    );
  }

  data.comments.splice(index, 1);

  await saveData(data);

  return ok({
    success: true,
  });
}

/* =========================================================
   BAN
========================================================= */

async function banUser(
  event,
  user,
  body,
  data
) {
  if (!isModerator(user)) {
    return error(
      403,
      "Accès modération refusé."
    );
  }

  const discordId = String(
    body.discordId || ""
  ).trim();

  if (!discordId) {
    return error(
      400,
      "Discord ID invalide."
    );
  }

  if (discordId === MODERATOR_ID) {
    return error(
      403,
      "Impossible de bannir le propriétaire de la modération."
    );
  }

  const duration =
    body.duration ||
    "permanent";

  const durationMs =
    durationToMs(duration);

  const expiresAt =
    durationMs === null
      ? null
      : Date.now() + durationMs;

  const reason = String(
    body.reason ||
      "Aucune raison fournie"
  )
    .trim()
    .slice(0, 500);

  data.bans[discordId] = {
    discordId,
    reason,
    duration: String(duration),
    bannedAt: Date.now(),
    expiresAt,
    moderatorDiscordId:
      String(user.discordId),
    moderatorUsername:
      user.username || "",
  };

  addModerationLog(
    data,
    "ban",
    user,
    {
      targetDiscordId:
        discordId,
      duration:
        String(duration),
      reason,
      expiresAt,
    }
  );

  await saveData(data);

  return ok({
    success: true,
    ban: data.bans[discordId],
  });
}

/* =========================================================
   UNBAN
========================================================= */

async function unbanUser(
  event,
  user,
  body,
  data
) {
  if (!isModerator(user)) {
    return error(
      403,
      "Accès modération refusé."
    );
  }

  const discordId = String(
    body.discordId || ""
  ).trim();

  if (!discordId) {
    return error(
      400,
      "Discord ID invalide."
    );
  }

  const existed =
    !!data.bans[discordId];

  delete data.bans[discordId];

  addModerationLog(
    data,
    "unban",
    user,
    {
      targetDiscordId:
        discordId,
    }
  );

  await saveData(data);

  return ok({
    success: true,
    existed,
  });
}

/* =========================================================
   PUBLIC DATA
========================================================= */

async function publicData(
  event,
  user,
  data
) {
  /*
    On ne renvoie PAS les IDs des votants.
    On fournit les compteurs et le statut
    du vote de l'utilisateur connecté.
  */

  const voteCounts = {};
  const voted = {};

  for (const [
    adId,
    voters,
  ] of Object.entries(data.votes)) {
    const list =
      Array.isArray(voters)
        ? voters
        : [];

    voteCounts[adId] =
      list.length;

    if (user?.discordId) {
      voted[adId] =
        list.includes(
          String(user.discordId)
        );
    }
  }

  return ok({
    ads: data.ads,
    comments: data.comments,
    votes: voteCounts,
    voted,
  });
}

/* =========================================================
   ME
========================================================= */

async function me(event) {
  const user =
    await getSession(event);

  if (!user) {
    return ok({
      authenticated: false,
      user: null,
    });
  }

  return ok({
    authenticated: true,

    user: {
      discordId:
        user.discordId,

      username:
        user.username || "",

      avatar:
        user.avatar || null,

      guilds:
        Array.isArray(user.guilds)
          ? user.guilds
          : [],
    },
  });
}

/* =========================================================
   MODERATION DATA
========================================================= */

async function moderationData(
  event,
  user,
  data
) {
  if (!isModerator(user)) {
    return error(
      403,
      "Accès modération refusé."
    );
  }

  /*
    Nettoyage des bans expirés.
  */

  for (const id of Object.keys(
    data.bans
  )) {
    if (
      data.bans[id].expiresAt !==
        null &&
      Number(
        data.bans[id].expiresAt
      ) <= Date.now()
    ) {
      delete data.bans[id];
    }
  }

  /*
    Création d'une liste d'utilisateurs
    connue à partir des publications,
    commentaires et bans.
  */

  const users = new Map();

  for (const ad of data.ads) {
    if (!ad.authorDiscordId)
      continue;

    users.set(
      String(ad.authorDiscordId),
      {
        discordId:
          String(ad.authorDiscordId),

        username:
          ad.authorUsername || "",

        avatar:
          ad.authorAvatar || null,
      }
    );
  }

  for (const comment of data.comments) {
    if (!comment.discordId)
      continue;

    const id =
      String(comment.discordId);

    if (!users.has(id)) {
      users.set(id, {
        discordId: id,
        username:
          comment.username || "",
        avatar:
          comment.avatar || null,
      });
    }
  }

  for (const ban of Object.values(
    data.bans
  )) {
    const id =
      String(ban.discordId);

    if (!users.has(id)) {
      users.set(id, {
        discordId: id,
        username: "",
        avatar: null,
      });
    }
  }

  const totalVotes =
    Object.values(data.votes)
      .reduce(
        (total, voters) =>
          total +
          (Array.isArray(voters)
            ? voters.length
            : 0),
        0
      );

  const stats = {
    totalAds:
      data.ads.length,

    totalComments:
      data.comments.length,

    totalVotes,

    totalUsers:
      users.size,

    totalBans:
      Object.keys(data.bans).length,

    totalLogs:
      data.moderationLogs.length,
  };

  await saveData(data);

  return ok({
    ads: data.ads,
    comments: data.comments,
    bans: data.bans,
    users: [...users.values()],
    moderationLogs:
      data.moderationLogs,
    stats,
  });
}

/* =========================================================
   SINGLE BAN
========================================================= */

async function getBan(
  event,
  user,
  discordId,
  data
) {
  if (!isModerator(user)) {
    return error(
      403,
      "Accès modération refusé."
    );
  }

  const id = String(
    discordId || ""
  ).trim();

  const ban =
    data.bans[id] || null;

  if (
    ban &&
    ban.expiresAt !== null &&
    Number(ban.expiresAt) <= Date.now()
  ) {
    delete data.bans[id];

    await saveData(data);

    return ok({
      ban: null,
    });
  }

  return ok({
    ban,
  });
}

/* =========================================================
   ACTION NORMALIZATION
========================================================= */

function normalizeAction(action) {
  const aliases = {
    create_ad: "createAd",
    update_ad: "updateAd",
    delete_ad: "deleteAd",

    toggle_vote: "vote",

    create_comment: "addComment",
    delete_comment: "deleteComment",

    moderator_delete_ad:
      "deleteAd",

    ban: "ban",
    unban: "unban",

    createAd: "createAd",
    updateAd: "updateAd",
    deleteAd: "deleteAd",

    vote: "vote",

    addComment: "addComment",
    deleteComment:
      "deleteComment",
  };

  return (
    aliases[String(action)] ||
    String(action)
  );
}

/* =========================================================
   MAIN ACTION HANDLER
========================================================= */

async function handleAction(
  event,
  action,
  user,
  body,
  data
) {
  switch (action) {
    case "createAd":
      return createAd(
        event,
        user,
        body,
        data
      );

    case "updateAd":
      return updateAd(
        event,
        user,
        body,
        data
      );

    case "deleteAd":
      return deleteAd(
        event,
        user,
        body,
        data
      );

    case "vote":
      return vote(
        event,
        user,
        body,
        data
      );

    case "addComment":
      return addComment(
        event,
        user,
        body,
        data
      );

    case "deleteComment":
      return deleteComment(
        event,
        user,
        body,
        data
      );

    case "ban":
      return banUser(
        event,
        user,
        body,
        data
      );

    case "unban":
      return unbanUser(
        event,
        user,
        body,
        data
      );

    default:
      return error(
        400,
        `Action inconnue : ${action}`
      );
  }
}

/* =========================================================
   NETLIFY HANDLER
========================================================= */

exports.handler = async (
  event
) => {
  try {
    /*
      Important pour @netlify/blobs
      dans une Netlify Function.
    */

    try {
      connectLambda(event);
    } catch (e) {
      /*
        Certaines versions/configurations
        n'en ont pas besoin.
      */
    }

    const method =
      String(
        event.httpMethod || "GET"
      ).toUpperCase();

    const data =
      await getData();

    /* =====================================
       GET
    ===================================== */

    if (method === "GET") {
      const params =
        event.queryStringParameters ||
        {};

      const action =
        String(
          params.action || "public"
        );

      if (action === "public") {
        const session =
          await getSession(event);

        return publicData(
          event,
          session,
          data
        );
      }

      if (action === "me") {
        return me(event);
      }

      const auth =
        await requireUser(event);

      if (auth.error) {
        return auth.error;
      }

      const user =
        auth.user;

      if (
        action === "moderation"
      ) {
        return moderationData(
          event,
          user,
          data
        );
      }

      if (action === "ban") {
        return getBan(
          event,
          user,
          params.discordId,
          data
        );
      }

      return error(
        400,
        "Action GET inconnue."
      );
    }

    /* =====================================
       POST
    ===================================== */

    if (method === "POST") {
      const body =
        parseBody(event);

      const rawAction =
        body.action;

      const action =
        normalizeAction(
          rawAction
        );

      const auth =
        await requireUser(event);

      if (auth.error) {
        return auth.error;
      }

      return handleAction(
        event,
        action,
        auth.user,
        body,
        data
      );
    }

    return error(
      405,
      "Méthode non autorisée."
    );
  } catch (err) {
    console.error(
      "storage.js error:",
      err
    );

    return error(
      500,
      "Erreur interne du serveur."
    );
  }
};
