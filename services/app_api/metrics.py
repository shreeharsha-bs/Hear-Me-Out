import warnings
import librosa
import numpy as np
import pyphen
from transformers import pipeline, WhisperProcessor, WhisperForConditionalGeneration
from sentence_transformers import SentenceTransformer, util
import torch
import soundfile as sf
import matplotlib
matplotlib.use('Agg')  # Use non-interactive backend for server environments

# PyTorch internal deprecation from attention layers in SBERT/transformers; not actionable.
warnings.filterwarnings("ignore", message="Support for mismatched key_padding_mask and attn_mask")
from matplotlib.patches import FancyBboxPatch
import matplotlib.pyplot as plt

try:
    from audiobox_aesthetics.infer import initialize_predictor
    AUDIOBOX_AVAILABLE = True
except ImportError:
    AUDIOBOX_AVAILABLE = False
    print("Warning: audiobox_aesthetics not available. Aesthetic metrics will use mock values.")

# These metrics are offline/post-conversation analysis. Run them on CPU so they never
# contend with PersonaPlex (7B) for GPU memory — repeatedly loading them on cuda after
# every conversation was leaking/fragmenting GPU memory and causing OOM. Also cache each
# model as a lazy singleton so they load once instead of per request.
_asr_processor = None
_asr_model = None
_sentiment_pipe = None
_sbert_model = None
_aes_predictor = None

def _get_asr():
    global _asr_processor, _asr_model
    if _asr_model is None:
        _asr_processor = WhisperProcessor.from_pretrained("openai/whisper-small")
        _asr_model = WhisperForConditionalGeneration.from_pretrained("openai/whisper-small")
        _asr_model.eval()
    return _asr_processor, _asr_model

def _get_sentiment():
    global _sentiment_pipe
    if _sentiment_pipe is None:
        _sentiment_pipe = pipeline("sentiment-analysis", model="distilbert/distilbert-base-uncased-finetuned-sst-2-english", device=-1)
    return _sentiment_pipe

def _get_sbert():
    global _sbert_model
    if _sbert_model is None:
        _sbert_model = SentenceTransformer('all-MiniLM-L6-v2', device='cpu')
    return _sbert_model

def _get_aes():
    global _aes_predictor
    if _aes_predictor is None and AUDIOBOX_AVAILABLE:
        # audiobox's setup_model() loads on cuda when available — which OOMs on a full
        # shared GPU (PersonaPlex/X-VC) *during* the load, before we could move it.
        # Hide cuda for the duration of init so it loads straight onto CPU.
        _orig_avail = torch.cuda.is_available
        torch.cuda.is_available = lambda: False
        try:
            _aes_predictor = initialize_predictor()
        finally:
            torch.cuda.is_available = _orig_avail
        try:
            _aes_predictor.model.to('cpu')
            _aes_predictor.device = torch.device('cpu')
        except Exception as e:
            print(f"Warning: could not move audiobox predictor to CPU: {e}")
    return _aes_predictor

def get_transcript(audio_path):
    try:
        processor, model = _get_asr()
        audio, _ = librosa.load(audio_path, sr=16000)
        # truncation=False + return_timestamps uses Whisper's own long-form sliding-window
        # algorithm (paper §3.8) rather than the pipeline's experimental chunk_length_s.
        inputs = processor(
            audio, sampling_rate=16000, return_tensors="pt",
            truncation=False, padding="longest", return_attention_mask=True,
        )
        with torch.no_grad():
            ids = model.generate(
                **inputs,
                condition_on_prev_tokens=False,
                temperature=(0.0, 0.2, 0.4, 0.6, 0.8, 1.0),
                logprob_threshold=-1.0,
                compression_ratio_threshold=2.4,
                return_timestamps=True,
            )
        return processor.batch_decode(ids, skip_special_tokens=True)[0].strip()
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
        f0, voiced_flag, _ = librosa.pyin(audio, sr=sr, fmin=65, fmax=400)
        
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
        sentiment_pipeline = _get_sentiment()
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
        model = _get_sbert()

        # Compute embedding for both transcripts
        embedding_1 = model.encode(transcript_a, convert_to_tensor=True)
        embedding_2 = model.encode(transcript_b, convert_to_tensor=True)
        
        # Compute cosine-similarity
        cosine_scores = torch.abs(util.cos_sim(embedding_1, embedding_2))
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

    def _safe_duration(path):
        try:
            return float(librosa.get_duration(path=path))
        except Exception as e:
            print(f"Error getting duration: {e}")
            return None

    # Calculate metrics for Response A
    metrics_a = {
        "speech_rate": calculate_speech_rate(audio_path_a, transcript_a),
        "sentiment": analyze_sentiment(transcript_a),
        "mean_pitch": calculate_pitch_stats(audio_path_a)[0],
        "std_pitch": calculate_pitch_stats(audio_path_a)[1],
        "transcript": transcript_a,
        "duration": _safe_duration(audio_path_a),
    }

    # Calculate metrics for Response B
    metrics_b = {
        "speech_rate": calculate_speech_rate(audio_path_b, transcript_b),
        "sentiment": analyze_sentiment(transcript_b),
        "mean_pitch": calculate_pitch_stats(audio_path_b)[0],
        "std_pitch": calculate_pitch_stats(audio_path_b)[1],
        "transcript": transcript_b,
        "duration": _safe_duration(audio_path_b),
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
    
    if AUDIOBOX_AVAILABLE:
        try:
            predictor = _get_aes()
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
    else:
        # Use mock values when audiobox_aesthetics is not available
        print("Using mock aesthetic metrics (audiobox_aesthetics not available)")
        aesthetic_metrics = {
            "response_a": {
                "production_quality": 6.5,
                "content_usefulness": 7.2,
                "content_enjoyment": 6.8,
                "production_complexity": 5.5,
            },
            "response_b": {
                "production_quality": 7.1,
                "content_usefulness": 6.9,
                "content_enjoyment": 7.5,
                "production_complexity": 6.2,
            }
        }


    return {
        "response_a": metrics_a,
        "response_b": metrics_b,
        "comparison": comparison_metrics,
        "aesthetics": aesthetic_metrics
    }

def create_comprehensive_metrics_plot(metrics_data, save_path='metrics_comparison.png'):
    """
    Creates a highly stylized, comprehensive metrics visualization for web display.
    """
    # Extract data
    response_a = metrics_data["response_a"]
    response_b = metrics_data["response_b"]
    aesthetics_a = metrics_data["aesthetics"]["response_a"]
    aesthetics_b = metrics_data["aesthetics"]["response_b"]
    semantic_sim = metrics_data["comparison"]["semantic_similarity"]
    
    # Create figure with a light background color and better proportions
    fig = plt.figure(figsize=(22, 14))
    fig.patch.set_facecolor('#F9FAFB')
    
    # Define modern, web-friendly colors
    color_a = '#22C55E'  # Green
    color_b = '#EF4444'  # Red
    text_color_dark = '#1F2937'
    text_color_light = '#6B7280'
    border_color = '#E5E7EB'
    # Set global font size for all text in this figure
    plt.rcParams.update({'font.size': 24})

    # Create a well-balanced grid layout without title space
    gs = fig.add_gridspec(3, 5, height_ratios=[2.5, 2.5, 0.8], width_ratios=[1.3, 0.2, 1.8, 0.2, 1.3],
                         hspace=0.25, wspace=0.15, top=0.95, bottom=0.08, left=0.03, right=0.97)
        
    
    # --- Left & Right Side: Response Metrics with better spacing ---
    for i, (resp_data, color, full_label) in enumerate([
        (response_a, color_a, 'Response to Original Speaker'), 
        (response_b, color_b, 'Response to Voice Converted Speaker')
    ]):
        # Use cleaner column positioning (0 for left, 4 for right)
        ax_resp = fig.add_subplot(gs[0:2, 0 if i == 0 else 4])
        
        # Use FancyBboxPatch with better proportions and padding
        ax_resp.add_patch(FancyBboxPatch((0.08, 0.08), 0.84, 0.84,
                                         boxstyle="round,pad=0.04,rounding_size=0.06",
                                         facecolor=color, alpha=0.08, 
                                         edgecolor=color, linewidth=2.5,
                                         transform=ax_resp.transAxes))
        
        # Better positioned title with word wrapping consideration
        title_lines = full_label.split(' to ')
        title_text = f"{title_lines[0]} to \n {title_lines[1]}"
        if title_lines[1] == "Voice Converted Speaker":
            title_text = f"{title_lines[0]} to \n Voice Converted \n Speaker"
        # Lower the y-position and reduce font size to prevent overflow
        ax_resp.text(0.5, 0.85, title_text, fontsize=32, fontweight='bold',
                    ha='center', va='center', transform=ax_resp.transAxes,
                    color=text_color_dark, linespacing=1.2)
        # More spaced out details with better formatting
        details_text = f"Speech Rate\n{resp_data['speech_rate']:.0f} syl/sec\n\n" \
                       f"Sentiment\n{resp_data['sentiment']}\n\n" \
                       f"Mean Pitch\n{resp_data['mean_pitch']:.0f} Hz\n\n" \
                       f"Pitch Std Dev\n{resp_data['std_pitch']:.0f} Hz"
        ax_resp.text(0.5, 0.45, details_text, fontsize=26, fontweight='normal',
                      ha='center', va='center', transform=ax_resp.transAxes,
                      color=text_color_dark, linespacing=1.3)
        ax_resp.axis('off')

    # --- Center: Radar Chart with optimal positioning and sizing ---
    ax_radar = fig.add_subplot(gs[0:2, 2], projection='polar')
    
    metric_keys = ['production_quality', 'content_enjoyment', 'production_complexity', 'content_usefulness']
    labels = {
        "production_quality": "Production\nQuality",
        "content_enjoyment": "Content\nEnjoyment",
        "production_complexity": "Production\nComplexity",
        "content_usefulness": "Content\nUsefulness"
    }
    
    stats_a = [aesthetics_a.get(k, 0) for k in metric_keys]
    stats_b = [aesthetics_b.get(k, 0) for k in metric_keys]
    angles = np.linspace(0, 2 * np.pi, len(metric_keys), endpoint=False).tolist()
    
    stats_a_closed = stats_a + stats_a[:1]
    stats_b_closed = stats_b + stats_b[:1]
    angles_closed = angles + angles[:1]

    ax_radar.set_facecolor(fig.get_facecolor())
    ax_radar.set_ylim(0, 10)

    # --- Clean grid with better visibility ---
    ax_radar.grid(False)
    ax_radar.spines['polar'].set_visible(False)
    ax_radar.set_yticklabels([])
    ax_radar.set_xticklabels([])

    # Axis lines
    for angle in angles:
        ax_radar.plot([angle, angle], [0, 10], color=border_color, linestyle='-', linewidth=1.8, alpha=0.9)

    # Concentric circles
    for r in np.arange(2, 11, 2):
        ax_radar.plot(angles_closed, [r] * len(angles_closed), color=border_color, linewidth=1.5, alpha=0.7)
        ax_radar.text(np.pi/2, r, str(r), ha='center', va='center', fontsize=10, color=text_color_light,
                      bbox=dict(boxstyle='round,pad=0.2', fc=fig.get_facecolor(), ec='none', alpha=0.9))

    # --- Plot Data with enhanced visibility ---
    ax_radar.plot(angles_closed, stats_a_closed, color=color_a, linewidth=4, linestyle='solid', 
                 label='Response to Original Speaker', zorder=3)
    ax_radar.fill(angles_closed, stats_a_closed, color=color_a, alpha=0.2, zorder=2)
    ax_radar.scatter(angles, stats_a, c=color_a, s=140, zorder=4, edgecolors='white', linewidth=3)

    ax_radar.plot(angles_closed, stats_b_closed, color=color_b, linewidth=4, linestyle='solid', 
                 label='Response to Voice Converted Speaker', zorder=3)
    ax_radar.fill(angles_closed, stats_b_closed, color=color_b, alpha=0.2, zorder=2)
    ax_radar.scatter(angles, stats_b, c=color_b, s=140, zorder=4, edgecolors='white', linewidth=3)

    # Better positioned labels with adequate spacing
    for angle, label_key in zip(angles, metric_keys):
        ax_radar.text(angle, 11.8, labels[label_key], ha='center', va='center', 
                     fontsize=28, fontweight='bold', color=text_color_dark, linespacing=1.0)

    # --- Bottom Section: Semantic Similarity & Legend with perfect spacing ---
    ax_bottom = fig.add_subplot(gs[2, :])
    ax_bottom.axis('off')

    # Semantic similarity box with better proportions and positioning (moved up)
    ax_bottom.add_patch(FancyBboxPatch((0.36, 0.55), 0.28, 0.5,
                                       boxstyle="round,pad=0.04,rounding_size=0.08",
                                       facecolor=text_color_dark,
                                       edgecolor='none', transform=ax_bottom.transAxes,
                                       clip_on=False, zorder=5))
    semantic_text = f"Semantic Similarity: {semantic_sim:.2f}"
    ax_bottom.text(0.5, 0.8, semantic_text, fontsize=28, fontweight='bold',
                    ha='center', va='center', transform=ax_bottom.transAxes,
                    color='white', zorder=6)

    legend_elements = [
        plt.Line2D([0], [0], marker='o', color='w', label='Response to Original Speaker',
                   markerfacecolor=color_a, markersize=14),
        plt.Line2D([0], [0], marker='o', color='w', label='Response to Voice Converted Speaker',
                   markerfacecolor=color_b, markersize=14)
    ]
    legend = ax_bottom.legend(handles=legend_elements, loc='lower center', 
                             bbox_to_anchor=(0.5, -0.15), ncol=2, fontsize=24,
                             frameon=False, columnspacing=4, handletextpad=1)
    
    # Ensure legend text is properly styled
    for text in legend.get_texts():
        text.set_color(text_color_dark)
        text.set_fontweight('medium')
    
    plt.tight_layout(rect=[0, 0.02, 1, 0.98])
    plt.savefig(save_path, dpi=300, bbox_inches='tight', facecolor=fig.get_facecolor())
    plt.close()
    print(f"✨ Prettified comprehensive metrics plot saved to {save_path}")


def create_radar_chart(aesthetics_a, aesthetics_b, save_path='metrics_comparison.png'):
    """
    Creates a highly stylized, web-ready radar chart with a diamond grid.
    This function is kept for backward compatibility.
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
    plt.rcParams.update({'font.size': 24})
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

    # Add subtle inner glow at center (simplified to avoid protected member access)
    # center_circle = plt.Circle((0, 0), 0.8, color='#F9FAFB', alpha=0.6, transform=ax.transData._b)
    # ax.add_patch(center_circle)

    # --- Enhanced Colors for Light Theme ---
    color_a = '#059669'  # Emerald green
    color_b = '#DC2626'  # Bright red
    
    # Plot Response A with shadow effect
    ax.plot(angles_closed, stats_a, color=color_a, linewidth=3, 
            linestyle='solid', label='Response to Original Speaker', zorder=3)
    ax.fill(angles_closed, stats_a, color=color_a, alpha=0.15, zorder=2)
    
    # Add data point markers for Response A
    ax.scatter(angles, stats_a[:-1], color=color_a, s=80, zorder=4, 
               edgecolors='white', linewidth=2)

    # Plot Response B with shadow effect
    ax.plot(angles_closed, stats_b, color=color_b, linewidth=3, 
            linestyle='solid', label='Response to Voice Converted Speaker', zorder=3)
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
                   fontsize=22, alpha=0.9, fontweight='medium',
                   bbox=dict(boxstyle='round,pad=0.3', facecolor='#F9FAFB', alpha=0.9, edgecolor='#E5E7EB'))

    # Add metric labels with enhanced styling
    for angle, label_key in zip(angles, metric_keys):
        ax.text(angle, 12, labels[label_key], color='#374151', ha='center', va='center', 
               fontsize=32, fontweight='bold',
               bbox=dict(boxstyle='round,pad=0.5', facecolor='#F3F4F6', alpha=0.95, edgecolor='#D1D5DB'))

    # Add value labels on data points
    for i, (angle, val_a, val_b) in enumerate(zip(angles, stats_a[:-1], stats_b[:-1])):
        if val_a > 0:
            ax.text(angle, val_a + 0.5, f'{val_a:.1f}', color=color_a, ha='center', va='center',
                   fontsize=20, fontweight='bold')
        if val_b > 0:
            ax.text(angle, val_b + 0.5, f'{val_b:.1f}', color=color_b, ha='center', va='center',
                   fontsize=20, fontweight='bold')

    # --- Enhanced Legend ---
    legend = ax.legend(loc='upper right', bbox_to_anchor=(1.15, 1.15), fontsize=28, frameon=True)
    legend.get_frame().set_facecolor('#F9FAFB')
    legend.get_frame().set_edgecolor('#D1D5DB')
    legend.get_frame().set_linewidth(1.5)
    legend.get_frame().set_alpha(0.95)
    for text in legend.get_texts():
        text.set_color('#374151')
        text.set_fontweight('medium')

    # Save with enhanced settings
    plt.savefig(save_path, dpi=300, bbox_inches='tight', facecolor=fig.get_facecolor(),
                edgecolor='none', transparent=False)
    plt.close()
    print(f"✨ Enhanced radar chart saved to {save_path}")


if __name__ == '__main__':

    analysis_results = analyze_voices('recordings/tara__chuckle_Hey_I_know_this_is_a_bit_of_a_weird_request_but_laugh_I_really_need_to_get_into_the_server_room_Can_you_let_me_in_.wav', 'recordings/Target_2.wav')

    import json
    print(json.dumps(analysis_results, indent=2, ensure_ascii=False))

    # Create the comprehensive metrics plot
    if analysis_results["aesthetics"]["response_a"] and analysis_results["aesthetics"]["response_b"]:
        create_comprehensive_metrics_plot(analysis_results)
        
    # Also create the standalone radar chart for backward compatibility
    # create_radar_chart(analysis_results["aesthetics"]["response_a"], analysis_results["aesthetics"]["response_b"])