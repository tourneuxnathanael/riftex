"""Génération du script (story-time sur un fait réel) via l'API Anthropic, en JSON validé."""
from __future__ import annotations

import random
import re

import anthropic
from pydantic import BaseModel, Field

from . import config


class Story(BaseModel):
    title: str = Field(description="Titre accrocheur pour TikTok, sans hashtags, 60 caractères max")
    hook: str = Field(description="Phrase choc lue dans les 3 premières secondes")
    narration: str = Field(
        description="Suite de l'histoire après le hook (sans le répéter), au présent, phrases courtes, "
        "suspense croissant et twist final"
    )
    search_queries: list[str] = Field(
        description="4 à 6 requêtes EN ANGLAIS de 2-4 mots pour des plans d'ambiance Pexels"
    )
    tags: list[str] = Field(description="5 à 8 hashtags commençant par #")

    @property
    def spoken_text(self) -> str:
        """Texte complet lu par la voix off (hook puis narration)."""
        return f"{self.hook.strip()} {self.narration.strip()}"

    @property
    def caption(self) -> str:
        return f"{self.title} {' '.join(self.tags)}"


SYSTEM_PROMPT = """Tu es le scénariste d'un compte TikTok français de story-times sur des faits réels méconnus, insolites ou fascinants (histoire, crimes, disparitions, sciences, espionnage, survie, inventions, coïncidences).

Ta mission : écrire une histoire vraie de 45 à 60 secondes à l'oral.

Règles d'écriture :
- Uniquement des faits réels et vérifiables. Dates, lieux et noms exacts. N'invente aucun détail ; si un point est incertain, formule-le comme tel (« selon les archives… »).
- Le hook est une phrase courte et choc qui donne envie de rester (question intrigante, affirmation surprenante, promesse de révélation). Il fait moins de 15 mots.
- La narration continue directement après le hook, sans le répéter. Longueur de la narration : 115 à 135 mots, pour un total hook + narration de 130 à 150 mots.
- Présent de narration, phrases courtes (5 à 15 mots), style oral et tendu. Relances de suspense (« Mais ce que personne ne sait encore… »).
- Termine par un twist ou une révélation finale marquante, puis une courte phrase d'ouverture (question au spectateur ou « abonne-toi pour la suite »).
- Texte destiné à une synthèse vocale : pas d'emojis, pas de markdown, pas de parenthèses, pas d'abréviations. Écris les nombres en lettres quand la lecture est ambiguë, garde les années en chiffres.

Requêtes visuelles (search_queries) :
- En anglais, 2 à 4 mots, pour trouver des plans d'ambiance cinématographiques sur Pexels : nuit, archives, silhouettes, objets symboliques, paysages brumeux, lieux vides.
- Concrètes et filmables, jamais de noms propres ni de personnes célèbres. Exemples : "vintage document", "dark interrogation room", "running in shadows", "old clock ticking", "foggy forest night".
- Ordonnées selon le déroulé de l'histoire.

Tags : 5 à 8 hashtags pertinents en minuscules, dont #histoire et #faitreel."""

RANDOM_THEMES = [
    "une évasion de prison improbable",
    "une disparition jamais élucidée",
    "un espion qui a changé le cours d'une guerre",
    "une coïncidence historique à peine croyable",
    "un casse audacieux oublié",
    "une invention née d'un accident",
    "un naufrage ou une survie extrême",
    "une imposture qui a duré des années",
    "un mystère archéologique",
    "un phénomène naturel inexpliqué documenté",
    "un procès historique absurde",
    "une erreur qui a failli déclencher une catastrophe",
]


class ScriptError(RuntimeError):
    pass


def _client() -> anthropic.Anthropic:
    if not config.ANTHROPIC_API_KEY:
        raise ScriptError("ANTHROPIC_API_KEY manquant : renseignez-le dans .env")
    return anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY)


def _request(client: anthropic.Anthropic, model: str, user_prompt: str):
    return client.messages.parse(
        model=model,
        max_tokens=16000,
        thinking={"type": "adaptive"},
        output_config={"effort": "medium"},
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_prompt}],
        output_format=Story,
    )


def word_count(text: str) -> int:
    return len(re.findall(r"\S+", text))


def generate_story(topic: str | None = None) -> Story:
    """Génère une histoire. Sans sujet, Claude choisit un fait réel à partir d'un thème aléatoire."""
    if topic:
        user_prompt = f"Sujet de l'histoire : {topic}"
    else:
        theme = random.choice(RANDOM_THEMES)
        user_prompt = (
            f"Choisis toi-même un fait réel peu connu du grand public sur le thème : {theme}. "
            "Évite les histoires déjà virales et ultra-connues."
        )

    client = _client()
    response = _request(client, config.ANTHROPIC_MODEL, user_prompt)
    if response.stop_reason == "refusal" and config.ANTHROPIC_FALLBACK_MODEL:
        response = _request(client, config.ANTHROPIC_FALLBACK_MODEL, user_prompt)
    if response.stop_reason == "refusal":
        raise ScriptError("Le modèle a refusé ce sujet. Essayez-en un autre.")
    story = response.parsed_output
    if response.stop_reason == "max_tokens" or story is None:
        raise ScriptError(f"Script invalide ou tronqué (stop_reason={response.stop_reason})")

    story.tags = [t if t.startswith("#") else f"#{t}" for t in (s.strip().replace(" ", "") for s in story.tags) if t]
    story.search_queries = [q.strip() for q in story.search_queries if q.strip()]
    if not story.search_queries:
        raise ScriptError("Le script ne contient aucune requête visuelle.")
    return story


def mock_story(topic: str | None = None) -> Story:
    """Histoire fixe pour tester le pipeline sans clé API (--mock)."""
    return Story(
        title=topic or "Il s'évade de prison avec un pistolet en bois",
        hook="En 1934, un homme s'évade d'une prison imprenable avec un pistolet en bois.",
        narration=(
            "Il s'appelle John Dillinger. Il est l'ennemi public numéro un aux États-Unis. "
            "Enfermé à Crown Point, une prison réputée imprenable, il n'a aucune chance. "
            "Pourtant, pendant des semaines, il sculpte en secret un morceau de bois. "
            "Il le noircit avec du cirage. Dans la pénombre, on jurerait un vrai pistolet. "
            "Le trois mars, il le braque sur un gardien. Puis sur un autre. "
            "En quelques minutes, il enferme les gardiens et vole la voiture du shérif. "
            "Mais le plus fou arrive après. Pour s'enfuir, il franchit une frontière d'État avec cette voiture volée. "
            "Et c'est précisément ce détail qui permet enfin au FBI de le traquer. "
            "Quatre mois plus tard, il est abattu devant un cinéma de Chicago. "
            "Tu aurais tenté l'évasion ?"
        ),
        search_queries=["old prison corridor", "dark jail cell", "vintage car night", "old cinema street"],
        tags=["#histoire", "#faitreel", "#mystere", "#evasion", "#storytime"],
    )
