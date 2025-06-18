# Hear Me Out: Exploring Conversational AI Through Speech-to-Speech Models
You can interact with Hear Me Out at this link: https://testing-moshi--hearmeout-web-dev.modal.run/

**Hear Me Out** is an interactive evaluation and bias discovery platform for speech-to-speech conversational AI. These speech-to-speech models process spoken language directly from audio, without first converting it to text. They promise more natural, expressive, and emotionally aware interactions by retaining prosody, intonation, and other vocal cues throughout the conversation.


---
The Hear Me Out block diagram
<img width="1648" alt="hearmeout-BD" src="https://github.com/user-attachments/assets/b282ad4a-354f-4452-ada2-59fafae65629" />
---


## Features

**Hear Me Out** enables users to experience interactions with conversational models in ways that aren't typically accessible with regular benchmarking systems. Key features include:

- **Speech-to-Speech Models**: Users can choose from a variety of models that retain vocal cues like prosody and intonation.
- **Real-Time Voice Conversion**: Step into someone else’s voice – literally – and investigate how conversational AI systems interpret and respond to various speaker identities and expressions.
- **Side-by-Side Comparisons**: Ask a question with your own voice, then re-ask using a transformed voice. Compare the AI’s responses to observe differences in tone, phrasing, or behavior.
- **Insights Through Data**: Visualize metrics like speech rate, sentiment analysis, and more. 
<img width="1381" alt="Screenshot 2025-03-31 at 13 19 18" src="https://github.com/user-attachments/assets/42c5cd60-0fe1-4e58-b198-ff12698e3b3a" />

Through this immersive experience, we hope users will gain insights into identity, voice, and AI behavior. Ultimately, we aim to surface meaningful questions and inspire future research that promotes fairness and inclusivity with **Hear Me Out**.

---


In the demo video, we explore the **Moshi** speech-to-speech model and its responses:

<video controls width="640">
  <source src="assets/IS_st_KTH_Hear-Me-Out-4th_draft.mp4" type="video/mp4">
</video>

### Example 1: Emotional Awareness

Notice how the model disambiguates between inputs with levity and frustration, correctly reflecting the speaker's emotional state in its responses. This distinction adds a more human-like quality to the interaction.

### Example 2: Voice Conversion

By applying voice transformations, we simulate how the model might respond to different speaker characteristics. While the differences in these responses are more subtle and inconsistent under repetition, hearing oneself in another voice opens up new perspectives.

## To run Hear Me Out yourself using Modal (which provides limited free hosting credits)

## Getting Started

### 1. Clone the Repository

First, you'll need to get a copy of this project on your local machine. Open a terminal and run:

```bash
git clone https://github.com/your-username/Hear-Me-Out.git
cd Hear-Me-Out
```

### 2. Set Up Your Development Environment

## Developing locally

### Requirements

- `modal` installed in your current Python virtual environment (`pip install modal`)
- A Modal account (`modal setup`)
- A Modal token set up in your environment (`modal token new`)

### Setting up Voice Conversion (seed-VC)

The voice conversion functionality uses the seed-VC library. To set this up:

1. Install the required dependencies for the local voice conversion server:

   ```bash
   pip install -r local_server_requirements.txt
   ```

2. Start the local voice conversion server in one terminal:

   ```bash
   python local_vc_server.py
   ```

3. In another terminal, start the Modal server:

   ```bash
   modal serve src.app
   ```

This workflow allows the application to use local voice conversion capabilities while serving the main application through Modal.

### Developing the inference module

The Moshi server is a Modal class module to load the models and maintain streaming state, with a FastAPI http server to expose a websocket interface over the internet.

To run a development server for the Moshi module, run this command from the root of the repo:

```bash
modal serve -m src.moshi
```

In the terminal output, you'll find a URL for creating a websocket connection.

While the `modal serve` process is running, changes to any of the project files will be automatically applied. Ctrl+C will stop the app.

### Testing the websocket connection

From a separate terminal, we can test the websocket connection directly from the command line with the `tests/moshi_client.py` client.

It requires non-standard dependencies, which can be installed with:

```bash
python -m venv venv
source venv/bin/activate
pip install -r requirements/requirements-dev.txt
```

With dependencies installed, run the terminal client with:

```bash
python tests/moshi_client.py
```

And begin speaking! Be sure to have your microphone and speakers enabled.

### Developing the http server and frontend

The http server at `src/app.py` is a second FastAPI app, for serving the frontend as static files.

A development server can be run with:

```bash
modal serve src.app
```

Since `src/app.py` imports the `src/moshi.py` module, this also starts the Moshi websocket server.

In the terminal output, you'll find a URL that you can visit to use your app. While the `modal serve` process is running, changes to any of the project files will be automatically applied. Ctrl+C will stop the app.

Note that for frontend changes, the browser cache may need to be cleared.

