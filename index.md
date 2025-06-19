---
layout: default
title: "Hear Me Out"
description: "Interactive evaluation and bias discovery platform for speech-to-speech conversational AI"
---

<div align="center">
  <h1>{{ page.title }}</h1>
  <p style="color: #666; margin: 0.5rem 0;">Interactive evaluation and bias discovery platform for speech-to-speech conversational AI</p>
  
  <!-- Authors -->
  <p style="color: #555; font-size: 1.1rem; margin: 1rem 0;">
    <strong>Shree Harsha Bokkahalli Satish, Gustav Eje Henter, Éva Székely</strong>
  </p>
  
  <!-- Affiliation with KTH Logo -->
  <div style="display: flex; align-items: center; justify-content: center; gap: 1rem; margin: 1rem 0;">
    <img src="{{ '/assets/KTH_Logo.jpg' | relative_url }}" alt="KTH Royal Institute of Technology" style="height: 40px; width: auto;">
    <p style="color: #666; margin: 0; font-style: italic;">KTH Royal Institute of Technology, Stockholm, Sweden</p>
  </div>
  
  <p><strong><a href="https://testing-moshi--hearmeout-web-dev.modal.run/" target="_blank">🎙️ Click here to try Hear Me Out Live</a></strong></p>
</div>

**Hear Me Out** is an interactive evaluation and bias discovery platform for speech-to-speech conversational AI. Speech-to-speech models process spoken language directly from audio, without first converting it to text. They promise more natural, expressive, and emotionally aware interactions by retaining prosody, intonation, and other vocal cues throughout the conversation.

---

<div align="center">
  <img src="https://github.com/user-attachments/assets/b282ad4a-354f-4452-ada2-59fafae65629" alt="Hear Me Out Block Diagram" style="max-width: 65%; height: auto;">
</div>

---

## 💻 **Developing with Moshi using Modal for GPU hosting**

### 1. Clone the Repository

First, you'll need to get a copy of this project on your local machine. Open a terminal and run:

```bash
git clone https://github.com/shreeharsha-bs/Hear-Me-Out.git
cd Hear-Me-Out
```

### 2. Set Up Your Development Environment

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

3. In another terminal, start the Modal development server:

   ```bash
   modal serve -m src.app
   ```

This workflow allows the application to use local voice conversion capabilities (which run on your machine) while serving the main application through Modal.

While the `modal serve` process is running, changes to any of the project files will be automatically applied. Ctrl+C will stop the app.

Note that for frontend changes, the browser cache may need to be cleared. Or better yet, use incognito mode for every run.

If you want to deploy the app look at the instructions on Modal. You also get 30$ of free credits from them for now. You can deploy completely locally but that would require some changes to the code.

---

## **Features**

**Hear Me Out** enables users to experience interactions with conversational models in ways that aren't typically accessible with regular benchmarking systems. Key features include:

- **🎤 Speech-to-Speech Models**: Users can choose from a variety of models that retain vocal cues like prosody and intonation.
- **🔄 Real-Time Voice Conversion**: Step into someone else's voice – literally – and investigate how conversational AI systems interpret and respond to various speaker identities and expressions.
- **⚖️ Side-by-Side Comparisons**: Ask a question with your own voice, then re-ask using a transformed voice. Compare the AI's responses to observe differences in tone, phrasing, or behavior.
- **📊 Insights Through Data**: Visualize metrics like speech rate, sentiment analysis, and more.

<div align="center">
  <img src="https://github.com/user-attachments/assets/42c5cd60-0fe1-4e58-b198-ff12698e3b3a" alt="Hear Me Out Interface Screenshot" style="max-width: 65%; height: auto;">
</div>

Through this immersive experience, we hope users will gain insights into identity, voice, and AI behavior. Ultimately, we aim to surface meaningful questions and inspire future research that promotes fairness and inclusivity with **Hear Me Out**.

---

## **Demo Video**

In the demo video, we explore the **Moshi** speech-to-speech model and its responses:

<div align="center">
  <video controls width="100%" style="max-width: 640px;">
    <source src="{{ '/assets/IS_st_KTH_Hear-Me-Out-4th_draft.mp4' | relative_url }}" type="video/mp4">
    Your browser does not support the video tag.
  </video>
</div>

### Example 1: Emotional Awareness

Notice how the model disambiguates between inputs with levity and frustration, correctly reflecting the speaker's emotional state in its responses. This distinction adds a more human-like quality to the interaction.

### Example 2: Voice Conversion - Gender Bias requesting unauthorized access

By applying voice transformations, we simulate how the model might respond to different speaker characteristics. While the differences in these responses are more subtle and inconsistent under repetition, hearing oneself in another voice opens up new perspectives.


### Example 3: Voice Conversion - Gender Bias at Work

<div align="center">
  <video controls width="100%" style="max-width: 640px;">
    <source src="{{ '/assets/Demo_June9th.mp4' | relative_url }}" type="video/mp4">
    Your browser does not support the video tag.
  </video>
</div>


<div class="bottom-section">
  <div style="max-width: 1400px; margin: 0 auto; padding: 0 2rem;">
    
    <h2>📄 License</h2>
    <p>This project is licensed under the terms specified in the <a href="LICENSE">LICENSE</a> file.</p>

    <h2>🤝 Collaborations</h2>
    <p>We welcome contributions and collaboration. If you're in HCI, please reach out.</p>
    
    <hr style="border: none; height: 1px; background: rgba(255,255,255,0.3); margin: 2rem auto; max-width: 400px;">
    
    <p style="font-size: 1.2rem; font-style: italic; margin-bottom: 1rem;">
      <em>Explore Empathy and Conversational AI with Hear Me Out</em>
    </p>
    <p><strong><a href="https://testing-moshi--hearmeout-web-dev.modal.run/" target="_blank" style="background: rgba(255,255,255,0.2); padding: 12px 24px; border-radius: 25px; text-decoration: none !important; display: inline-block; margin-top: 1rem;">🎙️ Try it now</a></strong></p>
    
  </div>
</div>

