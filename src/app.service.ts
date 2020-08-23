import { Injectable } from '@nestjs/common'

@Injectable()
export class AppService {
  getStatus(): { status: number; body: string } {
    return { status: 200, body: 'healthy' }
  }
}
