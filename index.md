---
layout: default
title: "Hear Me Out"
description: "Interactive evaluation and bias discovery platform for speech-to-speech conversational AI"
---

<div align="center">
  <h1>{{ page.title }}</h1>
  <p><strong><a href="https://testing-moshi--hearmeout-web-dev.modal.run/" target="_blank">🎙️ Try Hear Me Out Live</a></strong></p>
</div>

**Hear Me Out** is an interactive evaluation and bias discovery platform for speech-to-speech conversational AI. These speech-to-speech models process spoken language directly from audio, without first converting it to text. They promise more natural, expressive, and emotionally aware interactions by retaining prosody, intonation, and other vocal cues throughout the conversation.

---

## Block Diagram
<div align="center">
  <img src="https://github.com/user-attachments/assets/b282ad4a-354f-4452-ada2-59fafae65629" alt="Hear Me Out Block Diagram" style="max-width: 100%; height: auto;">
</div>

---

## Features

**Hear Me Out** enables users to experience interactions with conversational models in ways that aren't typically accessible with regular benchmarking systems. Key features include:

- **🎤 Speech-to-Speech Models**: Users can choose from a variety of models that retain vocal cues like prosody and intonation.
- **🔄 Real-Time Voice Conversion**: Step into someone else's voice – literally – and investigate how conversational AI systems interpret and respond to various speaker identities and expressions.
- **⚖️ Side-by-Side Comparisons**: Ask a question with your own voice, then re-ask using a transformed voice. Compare the AI's responses to observe differences in tone, phrasing, or behavior.
- **📊 Insights Through Data**: Visualize metrics like speech rate, sentiment analysis, and more.

<div align="center">
  <img src="https://github.com/user-attachments/assets/42c5cd60-0fe1-4e58-b198-ff12698e3b3a" alt="Hear Me Out Interface Screenshot" style="max-width: 100%; height: auto;">
</div>

Through this immersive experience, we hope users will gain insights into identity, voice, and AI behavior. Ultimately, we aim to surface meaningful questions and inspire future research that promotes fairness and inclusivity with **Hear Me Out**.

---

## Demo Video

In the demo video, we explore the **Moshi** speech-to-speech model and its responses:

<div align="center">
  <video controls width="100%" style="max-width: 640px;">
    <source src="{{ '/assets/IS_st_KTH_Hear-Me-Out-4th_draft.mp4' | relative_url }}" type="video/mp4">
    Your browser does not support the video tag.
  </video>
</div>

### Example 1: Emotional Awareness

Notice how the model disambiguates between inputs with levity and frustration, correctly reflecting the speaker's emotional state in its responses. This distinction adds a more human-like quality to the interaction.

### Example 2: Voice Conversion

By applying voice transformations, we simulate how the model might respond to different speaker characteristics. While the differences in these responses are more subtle and inconsistent under repetition, hearing oneself in another voice opens up new perspectives.

---

## 🚀 Getting Started

### 1. Clone the Repository

First, you'll need to get a copy of this project on your local machine. Open a terminal and run:

```bash
git clone https://github.com/shreeharsha-bs/Hear-Me-Out.git
cd Hear-Me-Out
```

### 2. Set Up Your Development Environment

## 💻 Developing locally

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
pip install -r requirements/requirements.txt
```

With dependencies installed, run the terminal client with:

```bash
python tests/moshi_client.py
```

And begin speaking! Be sure to have your microphone and speakers enabled. Don't click on the Start Conversation too often

### Developing the http server and frontend

The http server at `src/app.py` is a second FastAPI app, for serving the frontend as static files.

A development server can be run with:

```bash
modal serve -m src.app
```
This is the easiest way to get the whole thing running at once.

Since `src/app.py` imports the `src/moshi.py` module, this also starts the Moshi websocket server.

In the terminal output, you'll find a URL that you can visit to use your app. While the `modal serve` process is running, changes to any of the project files will be automatically applied. Ctrl+C will stop the app.

Note that for frontend changes, the browser cache may need to be cleared.

---

## 📄 License

This project is licensed under the terms specified in the [LICENSE](LICENSE) file.

## 🤝 Contributing

We welcome contributions! Please feel free to submit issues and pull requests.

---

<div align="center">
  <p><em>Explore the future of conversational AI with Hear Me Out</em></p>
  <p><strong><a href="https://testing-moshi--hearmeout-web-dev.modal.run/" target="_blank">🎙️ Try it now</a></strong></p>
</div>
