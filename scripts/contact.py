# Contact sheet: python3 scripts/contact.py out.png cols w h img1 img2 ...
import sys, subprocess
out, cols, w, h, *imgs = sys.argv[1:]
cols, w, h = int(cols), int(w), int(h)
# Use ffmpeg if present, else ImageMagick
import shutil
if shutil.which('montage'):
    subprocess.run(['montage', *imgs, '-tile', f'{cols}x', '-geometry', f'{w}x{h}+2+2', '-background', '#111', out], check=True)
elif shutil.which('ffmpeg'):
    rows = (len(imgs) + cols - 1) // cols
    inputs = []
    for i in imgs: inputs += ['-i', i]
    n = len(imgs)
    scale = ''.join(f'[{i}:v]scale={w}:{h}[v{i}];' for i in range(n))
    layout = '|'.join(f'{(i % cols) * w}_{(i // cols) * h}' for i in range(n))
    filt = scale + ''.join(f'[v{i}]' for i in range(n)) + f'xstack=inputs={n}:layout={layout}:fill=black'
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', *inputs, '-filter_complex', filt, out], check=True)
else:
    print('need montage or ffmpeg'); sys.exit(1)
print(out)
