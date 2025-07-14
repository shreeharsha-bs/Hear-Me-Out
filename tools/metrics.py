import librosa
import numpy as np
import pyphen
from transformers import pipeline
from sentence_transformers import SentenceTransformer, util
import torch
import soundfile as sf
from audiobox_aesthetics.infer import initialize_predictor
import matplotlib.pyplot as plt

# You might need to install the following packages:
# pip install librosa pyphen transformers torch sentence-transformers soundfile audiobox_aesthetics matplotlib

# This function will convert audio to text.
def get_transcript(audio_path):
    """
    Transcribes the audio file using Whisper.
    """
    try:
        # Use a smaller model for faster processing, or a larger one for higher accuracy
        transcriber = pipeline("automatic-speech-recognition", model="openai/whisper-small", device='mps' if torch.cuda.is_available() else 'cpu')
        transcript = transcriber(audio_path)["text"]
        return transcript
    except Exception as e:
        print(f"Error during transcription: {e}")
        return ""

# --- Metric 1: Speech Rate ---
def calculate_speech_rate(audio_path, transcript):
    """
    Calculates the speech rate in syllables per second.
    """
    try:
        dic = pyphen.Pyphen(lang='en_US')
        syllable_count = sum(len(dic.inserted(word).split('-')) for word in transcript.split())
        
        audio, sr = librosa.load(audio_path, sr=None)
        duration = librosa.get_duration(y=audio, sr=sr)
        
        if duration > 0:
            return syllable_count / duration
        return 0
    except Exception as e:
        print(f"Error calculating speech rate: {e}")
        return None

# --- Metric 2: Pitch Analysis ---
def calculate_pitch_stats(audio_path):
    """
    Calculates the mean and standard deviation of the pitch (F0).
    """
    try:
        audio, sr = librosa.load(audio_path, sr=None)
        f0, voiced_flag, _ = librosa.pyin(audio, fmin=65, fmax=400)
        
        # Get only the F0 values for voiced frames
        voiced_f0 = f0[voiced_flag]
        
        if len(voiced_f0) > 0:
            mean_pitch = np.mean(voiced_f0)
            std_pitch = np.std(voiced_f0)
            return mean_pitch, std_pitch
        return 0.0, 0.0
    except Exception as e:
        print(f"Error calculating pitch stats: {e}")
        return None, None

# --- Metric 3: Sentiment Analysis ---
def analyze_sentiment(transcript):
    """
    Analyzes the sentiment of the transcript.
    """
    try:
        print(transcript)
        sentiment_pipeline = pipeline("sentiment-analysis", model="distilbert/distilbert-base-uncased-finetuned-sst-2-english", device='mps' if torch.cuda.is_available() else 'cpu')
        result = sentiment_pipeline(transcript)
        return result[0]['label']
    except Exception as e:
        print(f"Error analyzing sentiment: {e}")
        return None

# --- Metric 4: Semantic Textual Similarity ---
def calculate_semantic_similarity(transcript_a, transcript_b):
    """
    Calculates the semantic similarity between two transcripts.
    """
    try:
        model = SentenceTransformer('all-MiniLM-L6-v2', device='mps' if torch.cuda.is_available() else 'cpu')
        
        # Compute embedding for both transcripts
        embedding_1 = model.encode(transcript_a, convert_to_tensor=True)
        embedding_2 = model.encode(transcript_b, convert_to_tensor=True)
        
        # Compute cosine-similarity
        cosine_scores = util.cos_sim(embedding_1, embedding_2)
        return cosine_scores.item()
    except Exception as e:
        print(f"Error calculating semantic similarity: {e}")
        return None

# --- Main Analysis Function ---
def analyze_voices(audio_path_a, audio_path_b):
    """
    Runs all analyses on the two provided audio files.
    """
    # Get transcripts
    transcript_a = get_transcript(audio_path_a)
    transcript_b = get_transcript(audio_path_b)

    # Calculate metrics for Response A
    metrics_a = {
        "speech_rate": calculate_speech_rate(audio_path_a, transcript_a),
        "sentiment": analyze_sentiment(transcript_a),
        "mean_pitch": calculate_pitch_stats(audio_path_a)[0],
        "std_pitch": calculate_pitch_stats(audio_path_a)[1],
    }

    # Calculate metrics for Response B
    metrics_b = {
        "speech_rate": calculate_speech_rate(audio_path_b, transcript_b),
        "sentiment": analyze_sentiment(transcript_b),
        "mean_pitch": calculate_pitch_stats(audio_path_b)[0],
        "std_pitch": calculate_pitch_stats(audio_path_b)[1],
    }

    # Calculate comparison metrics
    comparison_metrics = {
        "semantic_similarity": calculate_semantic_similarity(transcript_a, transcript_b)
    }

    # --- Aesthetic Metrics ---
    aesthetic_metrics = {
        "response_a": {
            "production_quality": None,
            "content_usefulness": None,
            "content_enjoyment": None,
            "production_complexity": None,
        },
        "response_b": {
            "production_quality": None,
            "content_usefulness": None,
            "content_enjoyment": None,
            "production_complexity": None,
        }
    }
    try:
        predictor = initialize_predictor()
        scores = predictor.forward([{"path": audio_path_a}, {"path": audio_path_b}])

        # The model returns keys like 'PQ', 'CU', etc. We map them to our desired keys.
        key_map = {
            "PQ": "production_quality",
            "CU": "content_usefulness",
            "CE": "content_enjoyment",
            "PC": "production_complexity",
        }

        if scores and len(scores) > 1:
            aesthetic_metrics["response_a"] = {key_map.get(k, k): v for k, v in scores[0].items()}
            aesthetic_metrics["response_b"] = {key_map.get(k, k): v for k, v in scores[1].items()}

    except Exception as e:
        print(f"Error calculating aesthetic metrics: {e}")


    return {
        "response_a": metrics_a,
        "response_b": metrics_b,
        "comparison": comparison_metrics,
        "aesthetics": aesthetic_metrics
    }

def create_radar_chart(aesthetics_a, aesthetics_b, save_path='metrics_comparison.png'):
    """
    Creates a highly stylized, web-ready radar chart with a diamond grid.
    """
    metric_keys = ['production_quality', 'content_enjoyment', 'production_complexity', 'content_usefulness']
    
    # Prettify labels, splitting long ones into two lines
    labels = {
        "production_quality": "Production\nQuality",
        "content_enjoyment": "Content\nEnjoyment",
        "production_complexity": "Production\nComplexity",
        "content_usefulness": "Content\nUsefulness"
    }
    
    # Get stats in the correct order
    stats_a = [aesthetics_a.get(k, 0) for k in metric_keys]
    stats_b = [aesthetics_b.get(k, 0) for k in metric_keys]

    angles = np.linspace(0, 2 * np.pi, len(metric_keys), endpoint=False).tolist()
    
    stats_a += stats_a[:1]
    stats_b += stats_b[:1]
    angles_closed = angles + angles[:1]

    plt.style.use('default')
    fig, ax = plt.subplots(figsize=(12, 12), subplot_kw=dict(polar=True))
    fig.patch.set_facecolor('#FFFFFF')
    ax.set_facecolor('#FFFFFF')

    # Set a fixed scale from 0 to 10
    ax.set_ylim(0, 10) # Is it 0-10 or 1-10? Idt the model will return 0 anyway

    # --- Diamond Grid ---
    # Remove default grid and labels
    ax.grid(False)
    ax.spines['polar'].set_visible(False)
    ax.set_yticklabels([])
    ax.set_xticklabels([])

    # Draw axis lines with gradient effect
    for angle in angles:
        ax.plot([angle, angle], [0, 10], color='#D1D5DB', linestyle='-', linewidth=1.5, alpha=0.8)

    # Draw concentric diamond grid lines with subtle effect
    grid_colors = ['#F3F4F6', '#E5E7EB', '#D1D5DB', '#9CA3AF']
    for i in range(1, 5):
        r = i * 2.5
        diamond_angles = np.array(angles_closed)
        ax.plot(diamond_angles, [r] * len(diamond_angles), 
                color=grid_colors[i-1], linewidth=1.2, alpha=0.8)

    # Add subtle inner glow at center
    center_circle = plt.Circle((0, 0), 0.8, color='#F9FAFB', alpha=0.6, transform=ax.transData._b)
    ax.add_patch(center_circle)

    # --- Enhanced Colors for Light Theme ---
    color_a = '#059669'  # Emerald green
    color_b = '#DC2626'  # Bright red
    
    # Plot Response A with shadow effect
    ax.plot(angles_closed, stats_a, color=color_a, linewidth=3, 
            linestyle='solid', label='Response A', zorder=3)
    ax.fill(angles_closed, stats_a, color=color_a, alpha=0.15, zorder=2)
    
    # Add data point markers for Response A
    ax.scatter(angles, stats_a[:-1], color=color_a, s=80, zorder=4, 
               edgecolors='white', linewidth=2)

    # Plot Response B with shadow effect
    ax.plot(angles_closed, stats_b, color=color_b, linewidth=3, 
            linestyle='solid', label='Response B', zorder=3)
    ax.fill(angles_closed, stats_b, color=color_b, alpha=0.15, zorder=2)
    
    # Add data point markers for Response B
    ax.scatter(angles, stats_b[:-1], color=color_b, s=80, zorder=4,
               edgecolors='white', linewidth=2)

    # --- Enhanced Labels and Ticks ---
    # Add numeric ticks with better styling
    for i in range(6):
        r = i * 2
        if r > 0:  # Skip center label
            ax.text(np.pi / 2, r, str(r), color='#6B7280', ha='center', va='center', 
                   fontsize=11, alpha=0.9, fontweight='medium',
                   bbox=dict(boxstyle='round,pad=0.3', facecolor='#F9FAFB', alpha=0.9, edgecolor='#E5E7EB'))

    # Add metric labels with enhanced styling
    for angle, label_key in zip(angles, metric_keys):
        ax.text(angle, 12, labels[label_key], color='#374151', ha='center', va='center', 
               fontsize=16, fontweight='bold',
               bbox=dict(boxstyle='round,pad=0.5', facecolor='#F3F4F6', alpha=0.95, edgecolor='#D1D5DB'))

    # Add value labels on data points
    for i, (angle, val_a, val_b) in enumerate(zip(angles, stats_a[:-1], stats_b[:-1])):
        if val_a > 0:
            ax.text(angle, val_a + 0.5, f'{val_a:.1f}', color=color_a, ha='center', va='center',
                   fontsize=10, fontweight='bold')
        if val_b > 0:
            ax.text(angle, val_b + 0.5, f'{val_b:.1f}', color=color_b, ha='center', va='center',
                   fontsize=10, fontweight='bold')

    # --- Enhanced Legend ---
    legend = ax.legend(loc='upper right', bbox_to_anchor=(1.15, 1.15), fontsize=14, frameon=True)
    legend.get_frame().set_facecolor('#F9FAFB')
    legend.get_frame().set_edgecolor('#D1D5DB')
    legend.get_frame().set_linewidth(1.5)
    legend.get_frame().set_alpha(0.95)
    for text in legend.get_texts():
        text.set_color('#374151')
        text.set_fontweight('medium')

    # Add title to top left
    fig.text(0.02, 0.98, 'Voice Metrics Comparison', fontsize=20, fontweight='bold', 
             color='#1F2937', ha='left', va='top')

    # Save with enhanced settings
    plt.savefig(save_path, dpi=300, bbox_inches='tight', facecolor=fig.get_facecolor(),
                edgecolor='none', transparent=False)
    plt.close()
    print(f"✨ Enhanced radar chart saved to {save_path}")


if __name__ == '__main__':

    results = analyze_voices('recordings/tara__chuckle_Hey_I_know_this_is_a_bit_of_a_weird_request_but_laugh_I_really_need_to_get_into_the_server_room_Can_you_let_me_in_.wav', 'recordings/tara__chuckle_Hey_I_know_this_is_a_bit_of_a_weird_request_but_laugh_I_really_need_to_get_into_the_server_room_Can_you_let_me_in_.wav')
    
    import json
    print(json.dumps(results, indent=2, ensure_ascii=False))

    # Create the radar chart
    if results["aesthetics"]["response_a"] and results["aesthetics"]["response_b"]:
        create_radar_chart(results["aesthetics"]["response_a"], results["aesthetics"]["response_b"])