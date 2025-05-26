# Hear Me Out: Exploring Conversational AI Through Speech-to-Speech Models

**Hear Me Out** is an exploratory tool for experiencing the paralinguistic and extra-linguistic capabilities of a new wave of conversational AI models. These speech-to-speech models process spoken language directly from audio, without first converting it to text. They promise more natural, expressive, and emotionally aware interactions by retaining prosody, intonation, and other vocal cues throughout the conversation.

In this video, we explore the **Moshi** speech-to-speech model and its responses:

### Example 1: Emotional Awareness
[VIDEO 1] [*play laugh and sigh pants]

Notice how the model disambiguates between inputs with levity and frustration, correctly reflecting the speaker's emotional state in its responses. This distinction adds a more human-like quality to the interaction.

### Example 2: Voice Conversion
[VIDEO 2] [*play server room]

By applying voice transformations, we simulate how the model might respond to different speaker characteristics. While the differences in these responses are more subtle and inconsistent under repetition, hearing oneself in another voice opens up new perspectives.

---

## Features

**Hear Me Out** enables users to experience interactions with conversational models in ways that aren't typically accessible with regular benchmarking systems. Key features include:

- **Speech-to-Speech Models**: Users can choose from a variety of models that retain vocal cues like prosody and intonation.
- **Real-Time Voice Conversion**: Step into someone else’s voice – literally – and investigate how conversational AI systems interpret and respond to various speaker identities and expressions.
- **Side-by-Side Comparisons**: Ask a question with your own voice, then re-ask using a transformed voice. Compare the AI’s responses to observe differences in tone, phrasing, or behavior.
- **Insights Through Data**: Visualize metrics like speech rate, sentiment analysis, and more. [INSERT GRAPHIC DEMOING SOME STATS ABOUT SPEECH RATE, SENTIMENT ANALYSIS ETC.]

Through this immersive experience, we hope users will gain insights into identity, voice, and AI behavior. Ultimately, we aim to surface meaningful questions and inspire future research that promotes fairness and inclusivity with **Hear Me Out**.

---

## File Structure

1. React frontend ([`src/frontend/`](./src/frontend/)), served by [`src/app.py`](./src/app.py)
2. Moshi websocket server ([`src/moshi.py`](./src/moshi.py))

---
### To run the whole backend and frontend use: 
# modal serve src.app
## Developing Locally

### Requirements

- `modal` installed in your current Python virtual environment (`pip install modal`)
- A [Modal](http://modal.com/) account (`modal setup`)
- A Modal token set up in your environment (`modal token new`)

### Testing the Websocket Connection

From a separate terminal, test the websocket connection directly from the command line with the `tests/moshi_client.py` client.

Install dependencies:

```shell
python -m venv venv
source venv/bin/activate
pip install -r requirements/requirements-dev.txt
```

Run the terminal client:

```shell
python tests/moshi_client.py
```

Begin speaking! Ensure your microphone and speakers are enabled.

### Running the HTTP Server and Frontend

The HTTP server at `src/app.py` is a second [FastAPI](https://fastapi.tiangolo.com/) app, for serving the frontend as static files.

Run a [development server](https://modal.com/docs/guide/webhooks#developing-with-modal-serve) with:

```shell
modal serve src.app
```

Since `src/app.py` imports the `src/moshi.py` module, this also starts the Moshi websocket server.

In the terminal output, you'll find a URL to visit and use your app. While the `modal serve` process is running, changes to any of the project files will be automatically applied. `Ctrl+C` will stop the app.

For frontend changes, clear the browser cache if necessary.

---

## Deploying to Modal

Once you're happy with your changes, [deploy](https://modal.com/docs/guide/managing-deployments#creating-deployments) your app:

```shell
modal deploy src.app
```

This will deploy both the frontend server and the Moshi websocket server.

Note that leaving the app deployed on Modal doesn't cost you anything! Modal apps are serverless and scale to 0 when not in use.