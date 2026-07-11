# 🛠️ Note de handoff — Backend LogisBJ

**Destinataire :** développeur backend (`logisbj-backend` — Node/Express + PostgreSQL sur Render)
**Contexte :** le frontend (`logisbj-web`) a été durci et enrichi sur les semaines 1→3 du plan de lancement (cible **15 août 2026**). Plusieurs fonctionnalités sont **livrées côté front mais dormantes** : elles attendent des champs ou des endpoints côté serveur. Ce document liste précisément ce qui reste à faire côté backend.

**API de production :** `https://logisbj-backend.onrender.com`

**Légende priorité :** 🔴 Critique (bloquant lancement) · 🟠 Important · 🟢 Souhaitable

---

## Résumé exécutif

| # | Chantier | Priorité | Débloque |
|---|----------|----------|----------|
| 1 | Champs `proprio_telephone`, `proprietaire_verifie`, `latitude/longitude` dans les réponses annonces | 🟠 | Boutons WhatsApp, badge ID, carte |
| 1 | Stockage `latitude/longitude` au POST annonce | 🟠 | Carte (positions réelles) |
| 2 | Webhook Kkiapay + vérification serveur du paiement | 🔴 | Sécurité paiement + fiabilité revenus |
| 3 | Compteur freemium côté serveur | 🔴 | Anti-contournement du paywall chercheurs |
| 4 | CSP, SRI, refresh token, VAPID | 🟠 | Durcissement sécurité |
| 5 | Index, contraintes NOT NULL, troncature nom proprio | 🟠 | Scalabilité + fuite de données perso |

---

## 1. Endpoints à modifier

Le frontend consomme déjà ces champs de façon **défensive** : s'ils sont absents, la fonctionnalité reste masquée sans erreur. Il suffit de les renvoyer pour activer la fonctionnalité.

### 1.1 `GET /api/annonces/:id` (détail)

Ajouter à l'objet `annonce` :

| Champ | Type | Usage frontend | Notes |
|-------|------|----------------|-------|
| `proprio_telephone` | `string` \| `null` | Bouton « Contacter sur WhatsApp » (`wa.me/229…`) | ⚠️ **Décision de confidentialité** : n'exposer que si le propriétaire a consenti à être contacté par WhatsApp (idéalement un flag `accepte_whatsapp`). Format libre : le front normalise (retire `+`, espaces, préfixe `229`). |
| `proprietaire_verifie` | `boolean` | Badge « ✓ ID » sur la carte propriétaire | Le front n'affiche le badge que si `=== true`. Ne pas renvoyer `true` par défaut : c'est une promesse de vérification d'identité réelle. |

Le front lit ces champs dans `ouvrirDetail()` → `annonceDetailCourante`. Voir `index.html` :
```js
(a.proprio_telephone ? '<button ... contacterWhatsApp ...>' : '')
(a.proprietaire_verifie === true ? '<div ...>✓ ID</div>' : '')
```

### 1.2 `GET /api/annonces` (liste)

Ajouter à chaque annonce :

| Champ | Type | Usage frontend |
|-------|------|----------------|
| `latitude` | `number` \| `null` | Carte : cercle de zone 200 m + marqueur-prix |
| `longitude` | `number` \| `null` | Idem |
| `proprietaire_verifie` | `boolean` | (optionnel ici) cohérence d'affichage |

**Important :** le front n'invente plus de positions. Une annonce **sans** `latitude`/`longitude` n'apparaît **pas** sur la carte (comportement voulu — fin des fausses positions GPS). Voir `chargerMarqueurs()` :
```js
const annoncesAvecCoords = data.annonces.filter(a => a.latitude && a.longitude);
```

### 1.3 `POST /api/annonces` (création)

Le front envoie désormais `latitude` et `longitude` dans le corps **quand l'utilisateur a utilisé le bouton « 📍 Ma position »** (sinon les clés sont absentes) :

```json
{
  "categorie_nom": "Studio",
  "titre": "…",
  "description": "…",
  "prix": 45000,
  "superficie": 35,
  "ville": "Cotonou",
  "quartier": "Cadjèhoun",
  "equipements": { "eau": true, "electricite": true },
  "latitude": 6.3703,
  "longitude": 2.3912
}
```

À faire côté backend :
- Accepter et **stocker** `latitude`/`longitude` (colonnes `numeric` — voir §5).
- **Valider les bornes du Bénin** : `latitude ∈ [6.0, 12.5]`, `longitude ∈ [0.7, 3.9]` (rejeter/ignorer hors zone pour éviter les coordonnées aberrantes).
- Champs optionnels : ne pas rendre obligatoires.

---

## 2. Webhook Kkiapay à implémenter 🔴

**Problème actuel (faille critique).** Après paiement, le front appelle `POST /api/paiements/confirmer-kkiapay` avec `{ transaction_id, plan, montant }` **fournis par le client**. Si le serveur fait confiance à ce corps, n'importe qui peut forger une confirmation (déclarer un plan « Agence Pro » à 15 000 F en ayant payé 2 000 F, ou inventer un `transaction_id`). La confirmation **ne doit jamais** reposer sur des données envoyées par le navigateur.

**Solution : vérification serveur via l'API Kkiapay + webhook.**

### 2.1 Endpoint webhook
- **URL à exposer :** `POST /api/paiements/webhook-kkiapay` (à déclarer dans le dashboard Kkiapay).
- Kkiapay notifie le serveur directement (serveur-à-serveur) à chaque transaction.

### 2.2 Vérification de la transaction
Pour chaque notification (webhook) **et** pour l'appel `confirmer-kkiapay`, re-vérifier côté serveur auprès de Kkiapay :
```
POST https://api.kkiapay.me/api/v1/transactions/status
Header: x-api-key: <SECRET_KKIAPAY>   (clé PRIVÉE, jamais côté front)
Body: { "transactionId": "<id>" }
```
Contrôler dans la réponse :
- `status === "SUCCESS"`
- `amount` **égal au montant attendu du plan** (ne pas faire confiance au `montant` du client) :
  - `chercheur` = 2000, `proprietaire` = 5000, `agence_pro` = 15000 (FCFA).
- La devise = XOF.

> ⚠️ La clé **publique** `af73694ed79631b4f492041f0602837f1c872739` visible dans le front est normale (widget). C'est la clé **privée** côté serveur qui sécurise la vérification. Vérifier qu'elle n'est **pas** committée dans le repo backend (doit être en variable d'env Render).

### 2.3 Idempotence
- Table `paiements` avec **contrainte `UNIQUE` sur `transaction_id`**.
- Avant d'activer un abonnement : `INSERT ... ON CONFLICT (transaction_id) DO NOTHING`. Si le webhook et le callback arrivent tous les deux (double notification), l'abonnement n'est activé qu'une fois.
- Journaliser chaque transaction (montant réel, plan, user, statut, horodatage).

### 2.4 Source de vérité de l'abonnement
- Le plan/expiration de l'abonnement doit être calculé **côté serveur** à partir des paiements vérifiés, jamais depuis `currentUser.abonnement` que le front stocke en `localStorage` (modifiable par l'utilisateur).
- Exposer `abonnement` et `abo_expire_le` dans la réponse `/auth/connexion` et un `/auth/me` — le front s'y fie pour l'affichage, mais l'autorisation réelle (publier, contacter au-delà du quota) doit être re-checkée serveur.

---

## 3. Freemium côté serveur 🔴

**État actuel.** Le compteur « 3 contacts gratuits/mois » est **frontend uniquement** (`localStorage`, clé `messages_gratuits_[userId]`, reset au 1ᵉʳ du mois). C'était volontaire pour livrer vite, mais **contournable** : vider le localStorage réinitialise le quota. Le backend doit faire foi avant le lancement public.

### 3.1 Comptage en base
Option recommandée : compter les conversations initiées (une conversation = un « contact »), ce que fait déjà le front via `POST /api/messages/conversations`.

```sql
-- Table dédiée (option simple, lisible)
CREATE TABLE quotas_contacts (
  user_id     uuid NOT NULL REFERENCES utilisateurs(id) ON DELETE CASCADE,
  periode     char(7) NOT NULL,           -- 'YYYY-MM'
  nb_contacts integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, periode)
);
```
Ou, sans nouvelle table : `COUNT(*)` sur les conversations créées par l'utilisateur dans le mois courant.

### 3.2 Application de la règle
Dans `POST /api/messages/conversations` :
1. Si l'utilisateur a un **abonnement actif** (`chercheur`/`proprietaire`/`agence_pro`, non expiré) → autoriser sans limite.
2. Sinon (`gratuit`), compter les contacts du **mois courant** (`to_char(now(),'YYYY-MM')`) :
   - `< 3` → créer la conversation, incrémenter le compteur.
   - `>= 3` → renvoyer **`402 Payment Required`** avec un corps explicite :
     ```json
     { "error": "QUOTA_ATTEINT", "message": "Quota de 3 contacts gratuits atteint ce mois-ci", "plan_suggere": "chercheur" }
     ```

### 3.3 Endpoint de statut (optionnel mais utile)
`GET /api/messages/quota` → `{ "utilises": 2, "max": 3, "restants": 1, "periode": "2026-08" }`
Permet au front d'afficher le compteur réel (aujourd'hui basé sur le localStorage) sur l'écran d'abonnement.

> Le front gère déjà gracieusement un `402` (il proposera l'abonnement). Aligner le seuil à **3** et le plan suggéré à **`chercheur` (2 000 FCFA)**. Le paywall **propriétaires** (5 000 FCFA pour publier) reste **inchangé**.

---

## 4. Sécurité restante 🟠

### 4.1 En-têtes CSP
Ajouter une Content-Security-Policy (via `helmet` — déjà dans les dépendances). Le front charge ces origines externes, à autoriser explicitement :

| Origine | Usage |
|---------|-------|
| `https://unpkg.com` | Leaflet (CSS/JS) |
| `https://cdn.socket.io` | Socket.io |
| `https://cdn.kkiapay.me` | Widget paiement |
| `https://*.gstatic.com` / `https://*.googleapis.com` | Firebase Messaging |
| `https://*.basemaps.cartocdn.com` | Tuiles carte |
| `wss://logisbj-backend.onrender.com` | WebSocket messagerie |

Exemple (à adapter — attention `unsafe-inline` : le front a des styles/scripts inline, à réduire à terme) :
```js
app.use(helmet.contentSecurityPolicy({
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com", "https://cdn.socket.io", "https://cdn.kkiapay.me", "https://*.gstatic.com"],
    styleSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"],
    imgSrc: ["'self'", "data:", "https://*.basemaps.cartocdn.com", "https://res.cloudinary.com"],
    connectSrc: ["'self'", "https://logisbj-backend.onrender.com", "wss://logisbj-backend.onrender.com", "https://api.kkiapay.me", "https://*.googleapis.com"],
    frameSrc: ["https://cdn.kkiapay.me"]
  }
}));
```
> La CSP est surtout servie avec le HTML. Comme le front est hébergé séparément (Vercel), poser ces en-têtes **aussi côté Vercel** (`vercel.json`). Coordonner avec l'hébergement front.

### 4.2 SRI (Sub-Resource Integrity) — côté front
Chantier **front** mais à tracer : ajouter `integrity="sha384-…"` + `crossorigin="anonymous"` sur les `<script>`/`<link>` CDN (Leaflet, Socket.io). Non applicable à Kkiapay/Firebase (contenu dynamique). À faire lors d'un prochain passage sur `index.html`.

### 4.3 Refresh token JWT
- Le front stocke `logisbj_token` **et** `logisbj_refresh` en `localStorage`, mais **le refresh token n'est jamais utilisé** → les sessions expirent sans renouvellement.
- À implémenter : `POST /api/auth/refresh` `{ refreshToken }` → `{ token, refreshToken }`. Rotation du refresh token à chaque usage, invalidation côté serveur (table `refresh_tokens` ou jti en liste de révocation).
- **Durée de vie :** access token court (~15 min), refresh long (~30 j).
- ⚠️ JWT en `localStorage` = exposé à tout XSS. Le front a été assaini (échappement systématique en S1), mais envisager à terme un cookie `HttpOnly; Secure; SameSite=Strict` pour le refresh token.

### 4.4 VAPID (Web Push / Firebase)
- La clé VAPID publique dans le front (`ozawhmOVP8-cNW1mdWrYz1Mpm5EUc6vKzU3sSVuX3Hs`, 43 car.) **ne ressemble pas à une clé VAPID valide** (les clés publiques VAPID font ~87 caractères et commencent par `B`). Le push échoue probablement en silence.
- **Régénérer une paire VAPID** (Firebase Console → Cloud Messaging → Web Push certificates), mettre la **clé privée** en variable d'env serveur, et communiquer la **clé publique** correcte à intégrer dans `index.html`.
- Endpoint `POST /api/notifications/token` (déjà appelé par le front avec `{ fcmToken }`) : vérifier qu'il persiste bien le token FCM par utilisateur et qu'il est utilisé à l'envoi (`message:recu`, `nouvelle:annonce`).

---

## 5. Base de données 🟠

### 5.1 Fuite de données personnelles (à corriger en priorité)
`GET /api/annonces` renvoie **`proprio_nom` et `proprio_prenom` en clair, sans authentification** (vérifié : `"proprietaire_nom":"BRIGA","proprietaire_prenom":"Sika"`). Le front n'affiche que « Sika B. », mais la donnée complète circule publiquement et est indexable/croisable avec le quartier.

**Action :** tronquer côté API **avant** l'envoi sur les endpoints publics (liste + détail) :
- Renvoyer `proprio_prenom` + **initiale** du nom uniquement (`proprio_nom_initiale: "B"`), ou un `proprio_nom_affiche: "Sika B."`.
- Ne jamais exposer le nom complet ni le téléphone sans règle de consentement (cf. §1.1).

### 5.2 Index manquants
La liste n'a pas de pagination serveur (le front récupère tout puis filtre/pagine — OK à ~100 annonces, pas au-delà). Prévoir :
```sql
CREATE INDEX idx_annonces_ville_statut     ON annonces (ville, statut);
CREATE INDEX idx_annonces_categorie        ON annonces (categorie_id);
CREATE INDEX idx_annonces_prix             ON annonces (prix);
CREATE INDEX idx_annonces_publie_le        ON annonces (publie_le DESC);
CREATE INDEX idx_messages_conversation     ON messages (conversation_id, envoye_le);
CREATE INDEX idx_conversations_user        ON conversations (chercheur_id, proprietaire_id);
-- Recherche texte (remplace le filtrage JS côté client) :
CREATE INDEX idx_annonces_recherche ON annonces USING gin (
  to_tsvector('french', coalesce(titre,'') || ' ' || coalesce(description,'') || ' ' || coalesce(quartier,''))
);
```
Puis exposer `GET /api/annonces?limit=&offset=&q=` (pagination + recherche `ILIKE`/`tsvector`) pour décharger le front.

### 5.3 Contraintes NOT NULL / DEFAULT
Constaté sur les données de prod : `publie_le` à `null` sur toutes les annonces, `note_moyenne` renvoyé en **chaîne** (`"0.00"`). Symptômes d'un schéma sans contraintes.
```sql
ALTER TABLE annonces ALTER COLUMN cree_le     SET DEFAULT now();
ALTER TABLE annonces ALTER COLUMN statut      SET DEFAULT 'en_attente';
ALTER TABLE annonces ALTER COLUMN statut      SET NOT NULL;
-- publie_le : renseigner à la validation (passage en 'disponible')
-- Typage : renvoyer note_moyenne / superficie en number (pas en string) côté API
```
- `latitude`/`longitude` : colonnes `numeric(9,6)` nullable (voir §1.3).
- `proprietaire_verifie` : `boolean NOT NULL DEFAULT false` sur la table `utilisateurs`.

### 5.4 Colonnes GPS + index géo (si la carte monte en puissance)
```sql
ALTER TABLE annonces ADD COLUMN latitude  numeric(9,6);
ALTER TABLE annonces ADD COLUMN longitude numeric(9,6);
-- À terme, pour les requêtes "autour de moi" : envisager PostGIS + index GiST.
```

### 5.5 Sauvegardes Render (à vérifier d'urgence)
Confirmer le **plan PostgreSQL Render** et l'état des **sauvegardes automatiques**. Sur les anciens plans gratuits, la base peut être supprimée après une période d'inactivité. Activer des backups quotidiens **avant** le lancement.

---

## Checklist de mise en production (backend)

- [ ] 🔴 Webhook Kkiapay + vérification serveur du montant + idempotence (`UNIQUE transaction_id`)
- [ ] 🔴 Clé privée Kkiapay en variable d'env (pas dans le repo)
- [ ] 🔴 Quota freemium 3/mois appliqué serveur (`402` au-delà)
- [ ] 🟠 `proprio_telephone` (avec consentement), `proprietaire_verifie`, `latitude/longitude` dans les réponses annonces
- [ ] 🟠 Stockage `latitude/longitude` au POST + validation bornes Bénin
- [ ] 🟠 Troncature nom propriétaire sur endpoints publics
- [ ] 🟠 Endpoint `POST /api/auth/refresh` + rotation
- [ ] 🟠 CSP (helmet) + coordination en-têtes Vercel
- [ ] 🟠 Régénérer la paire VAPID + fournir la clé publique correcte au front
- [ ] 🟠 Index SQL + pagination/recherche serveur `/api/annonces`
- [ ] 🟠 Contraintes NOT NULL/DEFAULT + typage numérique des réponses
- [ ] 🟢 Vérifier plan + backups PostgreSQL Render

---

## Référence : contrats d'API attendus par le front

| Endpoint | Méthode | Le front envoie | Le front attend |
|----------|---------|-----------------|-----------------|
| `/api/annonces` | GET | `?ville=&categorie_id=` | `{ annonces: [{ …, latitude, longitude, proprietaire_verifie }] }` |
| `/api/annonces/:id` | GET | — | `{ annonce: { …, proprio_telephone, proprietaire_verifie }, avis: [] }` |
| `/api/annonces` | POST | `{ …, latitude?, longitude? }` | `{ id }` |
| `/api/messages/conversations` | POST | `{ annonce_id, premier_message }` | `{ conversation_id }` ou `402 { error, plan_suggere }` |
| `/api/paiements/confirmer-kkiapay` | POST | `{ transaction_id, plan, montant }` | **ignorer `montant`, re-vérifier serveur** |
| `/api/paiements/webhook-kkiapay` | POST | *(Kkiapay → serveur)* | *(à créer)* |
| `/api/auth/refresh` | POST | `{ refreshToken }` | `{ token, refreshToken }` *(à créer)* |
| `/api/messages/quota` | GET | — | `{ utilises, max, restants, periode }` *(optionnel)* |

---

*Généré le 2026-07-11 dans le cadre du durcissement frontend (semaines 1→3). Les fonctionnalités « dormantes » côté front s'activeront automatiquement dès que les champs correspondants seront renvoyés par l'API — aucune modification front supplémentaire requise pour les points 1 et 3.*
