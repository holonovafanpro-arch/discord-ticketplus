# Discord Ticket Bot

Bot Discord de support/tickets avec panneau, creation de ticket, claim, add/remove, transcript, fermeture et configuration multi-serveur.

## 1) Prerequis

- Node.js 18+
- Un bot Discord cree sur le [Discord Developer Portal](https://discord.com/developers/applications)
- Le bot invite sur ton serveur avec les permissions admin (pour setup initial)

## 2) Installation

```bash
npm install
```

Copie `.env.example` vers `.env`, puis remplis les valeurs:

- `TOKEN`: token du bot
- `CLIENT_ID`: application id
- `GUILD_ID` (optionnel): id du serveur de test pour mise a jour instant des slash commands
- `STAFF_ROLE_ID` (optionnel): fallback du role staff si pas configure dans le serveur

## 3) Lancer le bot

```bash
npm start
```

## 4) Commandes

- `/setup-tickets` -> envoie le panneau de creation
- `/config view` -> affiche la config du serveur
- `/config set key:<...> value:<...>` -> modifie la config du serveur
- `/add user:@...` -> ajoute un membre au ticket
- `/remove user:@...` -> retire un membre du ticket
- `/claim` -> claim le ticket
- `/transcript` -> genere un fichier transcript
- `/close` -> log puis supprime le ticket

## 5) Notes

- Configuration stockee dans `data/guild-config.json`
- Les tickets sont multi-serveur (chaque serveur a ses IDs)
- Si aucune categorie/log n'est configuree, le bot les cree automatiquement
- Un utilisateur ne peut avoir qu'un ticket ouvert a la fois
