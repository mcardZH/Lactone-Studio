/* Private component probe. Only self-generated PCM/Opus, never product data. */
#include <windows.h>
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include "libavcodec/avcodec.h"
#include "libavformat/avformat.h"
#include "libavutil/version.h"
#include <opus.h>
#include "export_names.h"
#define API_LIST(X) X(avcodec_find_decoder) X(avcodec_get_name) X(avcodec_alloc_context3) X(avcodec_free_context) X(avcodec_open2) X(avcodec_parameters_to_context) X(avcodec_send_packet) X(avcodec_receive_frame) X(av_packet_alloc) X(av_packet_free) X(av_packet_unref) X(av_new_packet) X(av_frame_alloc) X(av_frame_free) X(av_frame_unref) X(avformat_alloc_context) X(avformat_open_input) X(avformat_find_stream_info) X(av_read_frame) X(avformat_close_input) X(avio_alloc_context) X(av_malloc) X(av_free) X(av_get_bytes_per_sample)
#define DECLARE(name) static __typeof__(&name) p_##name;
API_LIST(DECLARE)
#define CHECK(c) do { if (!(c)) { fprintf(stderr,"check failed line %d: %s\n",__LINE__,#c); return 1; } } while(0)
static unsigned char wav[44+4800*2];
static short input[4800];
typedef struct {unsigned char *data; int size,pos;} Memory;
static int read_memory(void *opaque,uint8_t *buf,int size) {
    Memory *m=opaque;int n=m->size-m->pos;if(n<=0)return AVERROR_EOF;if(size<n)n=size;
    memcpy(buf,m->data+m->pos,n);m->pos+=n;return n;
}
static int64_t seek_memory(void *opaque,int64_t offset,int whence) {
    Memory *m=opaque;if(whence==AVSEEK_SIZE)return m->size;
    whence&=~AVSEEK_FORCE;int64_t pos=offset+(whence==SEEK_CUR?m->pos:whence==SEEK_END?m->size:0);
    if(pos<0||pos>m->size)return AVERROR(EINVAL);m->pos=(int)pos;return pos;
}
static void le(unsigned char *p,unsigned v,int n){for(int i=0;i<n;i++)p[i]=(unsigned char)(v>>(8*i));}
static uint64_t fnv(const unsigned char *p,size_t n){uint64_t h=14695981039346656037ULL;for(size_t i=0;i<n;i++){h^=p[i];h*=1099511628211ULL;}return h;}
static int dump_frame(AVFrame *frame,FILE *out,int *count) {
    if(frame->format!=AV_SAMPLE_FMT_S16||frame->ch_layout.nb_channels!=1||frame->sample_rate!=48000)return -1;
    if(fwrite(frame->data[0],2,frame->nb_samples,out)!=(size_t)frame->nb_samples)return -1;
    *count+=frame->nb_samples;return 0;
}
int main(int argc,char **argv) {
    CHECK(argc==2);SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32|LOAD_LIBRARY_SEARCH_APPLICATION_DIR);
    wchar_t dll[MAX_PATH];CHECK(GetFullPathNameW(L"ffmpeg.dll",MAX_PATH,dll,NULL)>0);
    HMODULE module=LoadLibraryExW(dll,NULL,LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR|LOAD_LIBRARY_SEARCH_SYSTEM32);
    if(!module){fprintf(stderr,"LoadLibrary error %lu\n",GetLastError());return 1;}
#define LOAD(name) p_##name=(__typeof__(&name))GetProcAddress(module,#name);CHECK(p_##name);
    API_LIST(LOAD)
    for(unsigned i=0;i<sizeof(export_names)/sizeof(export_names[0]);i++)CHECK(GetProcAddress(module,export_names[i]));
    /* Official DLL does not export version functions; absence is recorded, never fabricated. */
    int versionExport=(GetProcAddress(module,"avcodec_version")!=NULL);
    CHECK(p_av_get_bytes_per_sample(AV_SAMPLE_FMT_S16)==2);
    CHECK(p_avcodec_find_decoder(AV_CODEC_ID_H264)&&p_avcodec_find_decoder(AV_CODEC_ID_AAC)&&p_avcodec_find_decoder(AV_CODEC_ID_OPUS));
    for(int i=0;i<4800;i++)input[i]=(short)((i*123)%60001-30000);
    memcpy(wav,"RIFF",4);le(wav+4,sizeof(wav)-8,4);memcpy(wav+8,"WAVEfmt ",8);le(wav+16,16,4);
    le(wav+20,1,2);le(wav+22,1,2);le(wav+24,48000,4);le(wav+28,96000,4);le(wav+32,2,2);le(wav+34,16,2);
    memcpy(wav+36,"data",4);le(wav+40,sizeof(input),4);memcpy(wav+44,input,sizeof(input));
    FILE *media=fopen("self-generated.wav","wb");CHECK(media);CHECK(fwrite(wav,1,sizeof(wav),media)==sizeof(wav));fclose(media);
    Memory memory={wav,sizeof(wav),0};unsigned char *buffer=p_av_malloc(4096);CHECK(buffer);
    AVIOContext *io=p_avio_alloc_context(buffer,4096,0,&memory,read_memory,NULL,seek_memory);CHECK(io);
    AVFormatContext *format=p_avformat_alloc_context();CHECK(format);format->pb=io;format->flags|=AVFMT_FLAG_CUSTOM_IO;
    CHECK(p_avformat_open_input(&format,NULL,NULL,NULL)==0);CHECK(p_avformat_find_stream_info(format,NULL)>=0);CHECK(format->nb_streams==1);
    CHECK(format->streams[0]->codecpar->codec_id==AV_CODEC_ID_PCM_S16LE);
    const AVCodec *codec=p_avcodec_find_decoder(format->streams[0]->codecpar->codec_id);CHECK(codec);
    AVCodecContext *ctx=p_avcodec_alloc_context3(codec);CHECK(ctx);CHECK(p_avcodec_parameters_to_context(ctx,format->streams[0]->codecpar)>=0);CHECK(p_avcodec_open2(ctx,codec,NULL)>=0);
    AVPacket *packet=p_av_packet_alloc();AVFrame *frame=p_av_frame_alloc();CHECK(packet&&frame);
    FILE *pcm=fopen("wav-decoded.s16","wb");CHECK(pcm);int count=0,ret;
    while((ret=p_av_read_frame(format,packet))>=0){CHECK(p_avcodec_send_packet(ctx,packet)>=0);p_av_packet_unref(packet);
        while((ret=p_avcodec_receive_frame(ctx,frame))>=0){CHECK(dump_frame(frame,pcm,&count)==0);p_av_frame_unref(frame);}CHECK(ret==AVERROR(EAGAIN)||ret==AVERROR_EOF);}
    CHECK(ret==AVERROR_EOF);CHECK(p_avcodec_send_packet(ctx,NULL)>=0);
    while((ret=p_avcodec_receive_frame(ctx,frame))>=0){CHECK(dump_frame(frame,pcm,&count)==0);p_av_frame_unref(frame);}CHECK(ret==AVERROR_EOF);fclose(pcm);CHECK(count==4800);
    p_avcodec_free_context(&ctx);p_avformat_close_input(&format);p_av_free(io->buffer);p_av_free(io);
    /* A single locally encoded 20ms Opus packet; no downloaded media. */
    int error;OpusEncoder *encoder=opus_encoder_create(48000,1,OPUS_APPLICATION_AUDIO,&error);CHECK(encoder&&error==OPUS_OK);
    unsigned char encoded[4000];int encodedBytes=opus_encode(encoder,input,960,encoded,sizeof(encoded));CHECK(encodedBytes>0);opus_encoder_destroy(encoder);
    media=fopen("self-generated.opus-packet","wb");CHECK(media);CHECK(fwrite(encoded,1,encodedBytes,media)==(size_t)encodedBytes);fclose(media);
    codec=p_avcodec_find_decoder(AV_CODEC_ID_OPUS);CHECK(codec);ctx=p_avcodec_alloc_context3(codec);CHECK(ctx);
    ctx->sample_rate=48000;ctx->ch_layout.order=AV_CHANNEL_ORDER_NATIVE;ctx->ch_layout.nb_channels=1;ctx->ch_layout.u.mask=AV_CH_LAYOUT_MONO;ctx->request_sample_fmt=AV_SAMPLE_FMT_S16;
    ctx->extradata=p_av_malloc(19+AV_INPUT_BUFFER_PADDING_SIZE);CHECK(ctx->extradata);memset(ctx->extradata,0,19+AV_INPUT_BUFFER_PADDING_SIZE);
    memcpy(ctx->extradata,"OpusHead",8);ctx->extradata[8]=1;ctx->extradata[9]=1;le(ctx->extradata+12,48000,4);ctx->extradata_size=19;
    CHECK(p_avcodec_open2(ctx,codec,NULL)>=0);CHECK(p_av_new_packet(packet,encodedBytes)>=0);memcpy(packet->data,encoded,encodedBytes);
    CHECK(p_avcodec_send_packet(ctx,packet)>=0);p_av_packet_unref(packet);CHECK(p_avcodec_receive_frame(ctx,frame)>=0);
    pcm=fopen("opus-decoded.s16","wb");CHECK(pcm);int opusCount=0;CHECK(dump_frame(frame,pcm,&opusCount)==0);fclose(pcm);CHECK(opusCount==960);
    p_av_frame_unref(frame);p_avcodec_free_context(&ctx);p_av_packet_free(&packet);p_av_frame_free(&frame);
    FILE *result=fopen("result.json","wb");CHECK(result);
    fprintf(result,"{\"headerVersion\":{\"avcodec\":%u,\"avformat\":%u,\"avutil\":%u},\"versionFunctionExported\":%s,\"apiPointersResolved\":24,\"wavSamples\":%d,\"opusSamples\":%d,\"opusPacketBytes\":%d,\"inputFNV1a\":\"%016llx\",\"sizes\":{\"AVFrame\":%zu,\"AVPacket\":%zu,\"AVCodecContext\":%zu,\"AVFormatContext\":%zu}}\n",LIBAVCODEC_VERSION_INT,LIBAVFORMAT_VERSION_INT,LIBAVUTIL_VERSION_INT,versionExport?"true":"false",count,opusCount,encodedBytes,(unsigned long long)fnv((unsigned char*)input,sizeof(input)),sizeof(AVFrame),sizeof(AVPacket),sizeof(AVCodecContext),sizeof(AVFormatContext));fclose(result);
    CHECK(FreeLibrary(module));return 0;
}
